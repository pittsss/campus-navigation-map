// Hand-drawn walking paths.
//
// The paths are points ("nodes") joined by lines ("edges"), stored in paths.json per campus.
// When a campus has paths, every route follows them (shortest way along the lines); a line
// between two floors is a staircase. Open the map with ?edit=1 to draw them.
import * as THREE from 'three';

const FILE = 'paths.json';
const HIT_PX = 14;             // how close (pixels) a click must be to a point to grab it
const ROOM_REACH = 4;          // a place without its own point uses the nearest point this close (m)

export function createPathNetwork(ctx) {
    // ctx: { site, scene, camera, controls, dom, floors, places, floorById, activeFloor(), setActiveFloor(id),
    //        heightAt(floor, v2), distToBox2(v2, box), onChange() }
    let file = { version: 1 };
    let net = { nodes: [], edges: [] };     // nodes: { id, f, x, z }   edges: [idA, idB]
    let nextId = 1;
    let adj = new Map();

    /* ---------- data ---------- */

    async function load() {
        try {
            const res = await fetch(`${FILE}?v=${Date.now()}`, { cache: 'no-store' });
            if (res.ok) file = await res.json();
        } catch { /* no paths yet */ }
        const mine = file[ctx.site] || {};
        net = { nodes: (mine.nodes || []).map(n => ({ ...n })), edges: (mine.edges || []).map(e => [...e]) };
        nextId = net.nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
        rebuild();
        console.info(`[paths] ${ctx.site}: ${net.nodes.length} points, ${net.edges.length} lines`);
    }

    function rebuild() {
        adj = new Map(net.nodes.map(n => [n.id, []]));
        const byId = new Map(net.nodes.map(n => [n.id, n]));
        net.edges = net.edges.filter(([a, b]) => byId.has(a) && byId.has(b) && a !== b);
        for (const [a, b] of net.edges) {
            const na = byId.get(a), nb = byId.get(b);
            const flat = Math.hypot(na.x - nb.x, na.z - nb.z);
            const fa = ctx.floorById(na.f), fb = ctx.floorById(nb.f);
            const len = na.f === nb.f ? flat : Math.hypot(flat, Math.max(2.5, Math.abs(fa.elevation - fb.elevation)));
            adj.get(a).push({ to: b, len });
            adj.get(b).push({ to: a, len });
        }
    }

    const nodeById = id => net.nodes.find(n => n.id === id);
    const v2 = n => new THREE.Vector2(n.x, n.z);

    /* ---------- routing ---------- */

    // The points a place connects to: its own points (inside it), else the nearest one close by.
    function attach(p) {
        const pad = 0.2;
        const inside = net.nodes.filter(n => n.f === p.floor.id && adj.get(n.id).length &&
            n.x >= p.box.min.x - pad && n.x <= p.box.max.x + pad && n.z >= p.box.min.z - pad && n.z <= p.box.max.z + pad);
        if (inside.length) return inside.map(n => ({ n, d: p.isRoom ? v2(n).distanceTo(p.center) : 0 }));
        let best = null, bestD = ROOM_REACH;
        for (const n of net.nodes) {
            if (n.f !== p.floor.id || !adj.get(n.id).length) continue;
            const d = ctx.distToBox2(v2(n), p.box);
            if (d < bestD) { bestD = d; best = n; }
        }
        return best ? [{ n: best, d: v2(best).distanceTo(p.center) }] : [];
    }

    function stairNear(floor, n) {
        let best = null, bestD = 3;
        for (const p of ctx.places.values()) {
            if (p.floor !== floor || p.kind !== 'stair') continue;
            const d = ctx.distToBox2(v2(n), p.box);
            if (d < bestD) { bestD = d; best = p; }
        }
        return best;
    }

    const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

    // Route along the drawn paths, in the same shape as the automatic router's result.
    // `penalty` (optional): Map edgeKey → factor making those lines look longer, used to find an
    // alternative route that avoids the first one. The result lists the lines it used (edgeKeys).
    function route(A, B, penalty = null) {
        if (!net.edges.length) return null;
        const starts = attach(A), goals = attach(B);
        if (!starts.length || !goals.length) return null;
        const goalD = new Map(goals.map(g => [g.n.id, g.d]));

        // Dijkstra from all start points at once
        const dist = new Map(), prev = new Map(), done = new Set();
        for (const s of starts) dist.set(s.n.id, s.d);
        let end = null, endCost = Infinity;
        while (true) {
            let cur = null, cd = Infinity;
            for (const [id, d] of dist) if (!done.has(id) && d < cd) { cd = d; cur = id; }
            if (cur === null || cd >= endCost) break;
            done.add(cur);
            if (goalD.has(cur) && cd + goalD.get(cur) < endCost) { endCost = cd + goalD.get(cur); end = cur; }
            for (const { to, len } of adj.get(cur)) {
                const nd = cd + len * (penalty?.get(edgeKey(cur, to)) || 1);
                if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, cur); }
            }
        }
        if (end === null) return null;
        const ids = [end];
        while (prev.has(ids[0])) ids.unshift(prev.get(ids[0]));

        // split into one run per floor; a line between floors is a staircase
        const runs = [];
        let run = null;
        ids.forEach((id, k) => {
            const n = nodeById(id), f = ctx.floorById(n.f);
            if (!run || run.floor !== f) {
                if (run) {
                    const from = nodeById(ids[k - 1]);
                    run.stairOut = stairNear(run.floor, from) || stairNear(f, n);   // the flight may live in either floor's model
                    run.stairLen = adj.get(from.id).find(e => e.to === id)?.len || 0;
                }
                run = { floor: f, pts: [] };
                runs.push(run);
            }
            run.pts.push(v2(n));
        });
        if (A.isRoom) runs[0].pts.unshift(A.center.clone());
        if (B.isRoom) runs[runs.length - 1].pts.push(B.center.clone());
        for (const r of runs) if (r.pts.length === 1) r.pts.push(r.pts[0].clone());
        if (!penalty) console.info(`[paths] route ${A.key} → ${B.key}: ${ids.length} points, ${runs.length} floor(s)`);
        const edgeKeys = ids.slice(1).map((id, k) => edgeKey(ids[k], id));
        return { A, B, runs, allow: new Set([A.index, B.index]), drawn: true, edgeKeys };
    }

    /* ---------- editor ---------- */

    let editing = false, selected = null, group = null, panel = null;
    const history = [];
    let dirty = false;

    const snapshot = () => JSON.stringify(net);
    function commit(before) {
        history.push(before);
        if (history.length > 200) history.shift();
        dirty = true;
        rebuild();
        draw();
        ctx.onChange();
    }

    const sphereGeo = new THREE.SphereGeometry(0.28, 14, 10);
    const cylGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 8, 1, true);
    const mats = {
        node: new THREE.MeshBasicMaterial({ color: 0x1565c0, depthTest: false, transparent: true }),
        lone: new THREE.MeshBasicMaterial({ color: 0x9e9e9e, depthTest: false, transparent: true }),
        sel: new THREE.MeshBasicMaterial({ color: 0xffb300, depthTest: false, transparent: true }),
        edge: new THREE.MeshBasicMaterial({ color: 0x1e88e5, depthTest: false, transparent: true, opacity: 0.85 }),
        stair: new THREE.MeshBasicMaterial({ color: 0xff7043, depthTest: false, transparent: true, opacity: 0.9 }),
    };

    function nodePos(n) {
        const f = ctx.floorById(n.f);
        return new THREE.Vector3(n.x, ctx.heightAt(f, v2(n)) + 0.3, n.z);
    }

    function draw() {
        if (group) { ctx.scene.remove(group); group = null; }
        if (!editing) return;
        group = new THREE.Group();
        group.renderOrder = 20;
        const act = ctx.activeFloor();
        const pos = new Map(net.nodes.map(n => [n.id, nodePos(n)]));
        for (const [a, b] of net.edges) {
            const na = nodeById(a), nb = nodeById(b);
            if (na.f !== act && nb.f !== act) continue;
            const pa = pos.get(a), pb = pos.get(b);
            const m = new THREE.Mesh(cylGeo, na.f === nb.f ? mats.edge : mats.stair);
            m.position.copy(pa).lerp(pb, 0.5);
            m.scale.set(1, Math.max(0.01, pa.distanceTo(pb)), 1);
            m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pb.clone().sub(pa).normalize());
            m.renderOrder = 20;
            group.add(m);
        }
        for (const n of net.nodes) {
            if (n.f !== act) continue;
            const m = new THREE.Mesh(sphereGeo, n.id === selected ? mats.sel : adj.get(n.id).length ? mats.node : mats.lone);
            m.position.copy(pos.get(n.id));
            if (n.id === selected) m.scale.setScalar(1.5);
            m.renderOrder = 21;
            group.add(m);
        }
        ctx.scene.add(group);
        updatePanel();
    }

    const pointer = new THREE.Vector2(), ray = new THREE.Raycaster();
    function setRay(ev) {
        const r = ctx.dom.getBoundingClientRect();
        pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(pointer, ctx.camera);
    }

    // Where the click lands on the active floor (follows the floor's height).
    function floorPoint(ev) {
        setRay(ev);
        const f = ctx.floorById(ctx.activeFloor());
        let y = f.elevation, hit = new THREE.Vector3();
        for (let k = 0; k < 3; k++) {
            if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit)) return null;
            const g = f.grid;
            if (hit.x < g.ox || hit.z < g.oz || hit.x > g.ox + g.nx * 0.2 || hit.z > g.oz + g.nz * 0.2) return null;
            y = ctx.heightAt(f, new THREE.Vector2(hit.x, hit.z));
        }
        return { x: +hit.x.toFixed(2), z: +hit.z.toFixed(2) };
    }

    function nodeAt(ev) {
        const r = ctx.dom.getBoundingClientRect();
        let best = null, bestD = HIT_PX;
        for (const n of net.nodes) {
            if (n.f !== ctx.activeFloor()) continue;
            const p = nodePos(n).project(ctx.camera);
            if (p.z > 1) continue;
            const sx = (p.x + 1) / 2 * r.width + r.left, sy = (1 - p.y) / 2 * r.height + r.top;
            const d = Math.hypot(sx - ev.clientX, sy - ev.clientY);
            if (d < bestD) { bestD = d; best = n; }
        }
        return best;
    }

    const hasEdge = (a, b) => net.edges.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));

    let down = null, drag = null;
    function onDown(ev) {
        if (!editing || ev.button !== 0) return;
        down = { x: ev.clientX, y: ev.clientY };
        const n = nodeAt(ev);
        if (n) {   // grab a point: dragging moves it, a plain click selects / connects
            drag = { n, before: snapshot(), moved: false };
            ctx.controls.enabled = false;
        }
    }
    function onMove(ev) {
        if (!drag) return;
        if (!drag.moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5) return;
        const p = floorPoint(ev);
        if (!p) return;
        drag.moved = true;
        drag.n.x = p.x; drag.n.z = p.z;
        draw();
    }
    function onUp(ev) {
        if (!editing || !down) return;
        ctx.controls.enabled = true;
        const wasDrag = drag;
        drag = null;
        const click = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5;
        down = null;
        if (wasDrag?.moved) { commit(wasDrag.before); return; }
        if (!click) return;
        const before = snapshot();
        const hit = wasDrag?.n || nodeAt(ev);
        if (hit) {
            if (selected === hit.id) { selected = null; draw(); return; }
            if (selected !== null) {
                const i = hasEdge(selected, hit.id);
                if (i >= 0) net.edges.splice(i, 1); else net.edges.push([selected, hit.id]);
                selected = hit.id;
                commit(before);
            } else { selected = hit.id; draw(); }
            return;
        }
        const p = floorPoint(ev);
        if (!p) return;
        const n = { id: nextId++, f: ctx.activeFloor(), x: p.x, z: p.z };
        net.nodes.push(n);
        if (selected !== null) net.edges.push([selected, n.id]);
        selected = n.id;
        commit(before);
    }

    function deleteSelected() {
        if (selected === null) return;
        const before = snapshot();
        net.nodes = net.nodes.filter(n => n.id !== selected);
        selected = null;
        commit(before);
    }
    function undo() {
        if (!history.length) return;
        net = JSON.parse(history.pop());
        if (selected !== null && !nodeById(selected)) selected = null;
        dirty = true;
        rebuild(); draw(); ctx.onChange();
    }
    function clearFloor() {
        const f = ctx.floorById(ctx.activeFloor());
        if (!confirm(`Delete all walking paths on the ${f.name}?`)) return;
        const before = snapshot();
        net.nodes = net.nodes.filter(n => n.f !== f.id);
        selected = null;
        commit(before);
    }

    function fileJson() {
        const out = { ...file, version: 1 };
        out[ctx.site] = { nodes: net.nodes, edges: net.edges };
        return JSON.stringify(out, null, 1);
    }
    function download() {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([fileJson()], { type: 'application/json' }));
        a.download = FILE;
        a.click();
        URL.revokeObjectURL(a.href);
    }
    async function save() {
        const status = panel.querySelector('.pe-status');
        try {
            const res = await fetch('/api/paths', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fileJson() });
            if (!res.ok) throw new Error(await res.text());
            file = JSON.parse(fileJson());
            dirty = false;
            status.textContent = 'Saved to paths.json ✓';
        } catch {
            download();
            status.textContent = 'Couldn’t save here — downloaded paths.json instead. Put it in the project folder.';
        }
        updatePanel();
    }

    function updatePanel() {
        if (!panel) return;
        const f = ctx.floorById(ctx.activeFloor());
        const onFloor = net.nodes.filter(n => n.f === f.id).length;
        panel.querySelector('.pe-count').textContent =
            `${f.name}: ${onFloor} points · whole campus: ${net.nodes.length} points, ${net.edges.length} lines${dirty ? ' · unsaved' : ''}`;
        panel.querySelector('.pe-sel').textContent = selected !== null
            ? 'A point is selected (orange): click the floor to continue the line, or another point to join them.'
            : 'Click the floor to start a line.';
    }

    function buildPanel() {
        panel = document.createElement('div');
        panel.className = 'path-editor';
        panel.innerHTML = `
            <strong>Editing walking paths</strong>
            <p class="pe-sel"></p>
            <details>
            <summary>How to draw</summary>
            <ul>
                <li>Click the floor to add a point; it joins the selected point.</li>
                <li>Click two points to join them (again to remove the line).</li>
                <li>Drag a point to move it · <kbd>Delete</kbd> removes the selected one · <kbd>Esc</kbd> deselects.</li>
                <li>Put a point inside each room, in its doorway, so routes use the door.</li>
                <li><b>Stairs:</b> select the point at the stairs, switch floor, click the matching spot.</li>
                <li>Paths are used for every route once saved. Places with no path nearby still get the automatic route.</li>
            </ul>
            </details>
            <p class="pe-count"></p>
            <div class="pe-actions">
                <button type="button" data-a="undo">Undo</button>
                <button type="button" data-a="clear">Clear floor</button>
                <button type="button" data-a="download">Download</button>
                <button type="button" data-a="save" class="primary">Save</button>
            </div>
            <p class="pe-status"></p>`;
        panel.addEventListener('click', e => {
            const a = e.target.closest('button')?.dataset.a;
            if (a === 'undo') undo();
            if (a === 'clear') clearFloor();
            if (a === 'download') download();
            if (a === 'save') save();
        });
        ctx.dom.parentElement.appendChild(panel);
    }

    function startEditing() {
        editing = true;
        buildPanel();
        ctx.dom.addEventListener('pointerdown', onDown);
        ctx.dom.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('keydown', e => {
            if (e.target.closest?.('input, select, textarea')) return;
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
            if (e.key === 'Escape') { selected = null; draw(); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
        });
        window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
        draw();
    }

    return {
        load, route, startEditing,
        get editing() { return editing; },
        refresh: draw,
        get hasPaths() { return net.edges.length > 0; },
    };
}
