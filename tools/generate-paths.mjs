// Rebuilds the main campus walking paths (paths.json) from:
//   - hallway centre lines (MANUAL below, traced from floor plans A-1..A-3, plus the model's corridor objects),
//   - every room's doorways (found from the gaps in its walls),
//   - the staircases between floors.
// It OVERWRITES the "main" paths in paths.json (hand edits made with map.html?edit=1 are lost).
//
// Usage (with the map server running):  npm i -D puppeteer-core   then   node tools/generate-paths.mjs
// Env: MAP_URL (default http://localhost:3000), CHROME (path to Chrome or Edge).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'paths.json');
const MAP_URL = process.env.MAP_URL || 'http://localhost:3000';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Hallway centre lines (world x, z) that aren't modelled as corridor objects. Floor id → polylines.
const MANUAL = {
    1: [
        [[2.4, -97.5], [69, -97.5]],                 // along the Minor Road
        [[2.4, -97.5], [2.4, -9.2]],                 // west side, service gate
        [[2.4, -9.2], [69, -9.2]],                   // along the National Road
        [[9.8, -97.5], [9.8, -76.6]],                // passage between Supply block and Automotive Lab
        [[2.4, -76.6], [56, -76.6]],                 // north covered walkway
        [[17.4, -76.6], [17.4, -22.8]],              // west walkway (Rm 117–125 / Lecture 122–124)
        [[2.4, -22.8], [56, -22.8]],                 // south covered walkway
        [[31.0, -76.6], [31.0, -9.2]],               // middle walkway → entrance gate
        [[56, -97.5], [56, -22.8]],                  // east walkway (Library, FBS, Student Lounge)
        [[31.0, -49.6], [56, -49.6]],                // across to the admin porch
        [[42.3, -49.6], [42.3, -69.5]],              // admin porch → central lobby
    ],
    2: [
        [[45.6, -67.4], [56.4, -67.4]],              // admin hallways ↔ SE connector (open side of the admin block)
        [[44.1, -76.4], [44.1, -70.8]],              // East corridor → passage → admin NE hallway
    ],
    3: [
        // BAC rooms: the strip outside their doors → Stair BAC → East walkway
        [[2.0, -94.5], [2.0, -78.2], [9.5, -78.2], [10.5, -76.6]],
        // admin lobby: a ring around the light well
        [[39.57, -57.40], [45.72, -57.40], [45.72, -64.05], [39.57, -64.05], [39.57, -57.40]],
    ],
};
const SKIP_AUTO = new Set(['3:Admin_lobby']);   // not a straight corridor (handled above)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
fs.writeFileSync(OUT, JSON.stringify({ ...JSON.parse(fs.readFileSync(OUT, 'utf8')), main: { nodes: [], edges: [] } }, null, 1));
await page.goto(`${MAP_URL}/map.html`, { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('loader')?.classList.contains('done'), { timeout: 400000 });

const result = await page.evaluate((MANUAL, SKIP) => {
    const { places, floors, portals } = window.campusMap;
    const SKIPS = new Set(SKIP);
    const plist = [...places.values()];
    const byIdx = new Map(plist.map(p => [p.index, p]));
    const lobbyLike = k => /(Lobby|Hall_Open|Corridor|Hallway|Stair|Landing)/i.test(k);
    const log = [];

    const nodes = [], edges = new Set(), roomInside = new Set();
    let nid = 1;
    const addNode = (f, x, z) => {
        for (const n of nodes) if (n.f === f && Math.hypot(n.x - x, n.z - z) < 0.25) return n.id;
        nodes.push({ id: nid, f, x: +x.toFixed(2), z: +z.toFixed(2) });
        return nid++;
    };
    const addEdge = (a, b) => { if (a !== b) edges.add(a < b ? `${a}-${b}` : `${b}-${a}`); };

    const cell = (g, x, z) => {
        const cx = Math.floor((x - g.ox) / 0.2), cz = Math.floor((z - g.oz) / 0.2);
        return cx < 0 || cz < 0 || cx >= g.nx || cz >= g.nz ? -1 : cz * g.nx + cx;
    };
    const passable = (g, i) => i >= 0 && !g.blocked[i] && (g.surf[i] !== Infinity || g.owner[i] >= 0);
    // clear walking line: no walls, no open air, no other people's rooms
    const los = (f, a, b, allow = new Set(), overVoid = false) => {
        const g = f.grid, L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 0.1));
        for (let k = 0; k <= n; k++) {
            const i = cell(g, a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n);
            if (i < 0 || g.blocked[i]) return false;
            if (!passable(g, i) && !overVoid) return false;
            const o = g.owner[i];
            if (o >= 0 && !allow.has(o)) { const p = byIdx.get(o); if (p.isRoom && !lobbyLike(p.raw)) return false; }
        }
        return true;
    };

    for (const f of floors) {
        const g = f.grid;
        // ---- 1. hallway segments
        const segs = [];
        for (const line of MANUAL[f.id] || []) for (let k = 0; k < line.length - 1; k++) segs.push({ a: line[k], b: line[k + 1], pts: [], src: 'manual' });
        for (const p of plist) {
            if (p.floor !== f || p.kind !== 'walkway' || SKIPS.has(p.key)) continue;
            const b = p.box, sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
            if (Math.max(sx, sz) < 1.5) continue;
            const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
            const s = sx >= sz ? { a: [b.min.x + 0.2, cz], b: [b.max.x - 0.2, cz] } : { a: [cx, b.min.z + 0.2], b: [cx, b.max.z - 0.2] };
            segs.push({ ...s, pts: [], src: p.raw });
        }
        // keep only the walkable part of each segment (split where it hits walls)
        const clean = [];
        for (const s of segs) {
            const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), n = Math.ceil(L / 0.2);
            let run = null;
            for (let k = 0; k <= n; k++) {
                const t = k / n, x = s.a[0] + (s.b[0] - s.a[0]) * t, z = s.a[1] + (s.b[1] - s.a[1]) * t;
                const i = cell(g, x, z);
                const ok = passable(g, i) && !(g.owner[i] >= 0 && byIdx.get(g.owner[i]).isRoom && !lobbyLike(byIdx.get(g.owner[i]).raw));
                if (ok) { if (!run) run = { a: [x, z], b: [x, z] }; else run.b = [x, z]; }
                if ((!ok || k === n) && run) { if (Math.hypot(run.b[0] - run.a[0], run.b[1] - run.a[1]) > 0.8) clean.push({ ...run, pts: [], src: s.src }); run = null; }
                if (!ok && s.src === 'manual') log.push(`F${f.id} manual line blocked near (${x.toFixed(1)}, ${z.toFixed(1)})`);
            }
        }
        const S = clean;
        const proj = (s, p) => {
            const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], L2 = dx * dx + dz * dz;
            const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dz) / L2));
            return { t, p: [s.a[0] + dx * t, s.a[1] + dz * t] };
        };
        const D = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
        // attach a point to the nearest hallway it can see; returns the node on the hallway
        const attachTo = (p, max, allow) => {
            const cands = [];
            for (const s of S) { const pr = proj(s, p); cands.push({ s, ...pr, d: D(p, pr.p) }); }
            cands.sort((u, v) => u.d - v.d);
            for (const c of cands) {
                if (c.d > max) break;
                if (los(f, p, c.p, allow)) { const id = addNode(f.id, c.p[0], c.p[1]); c.s.pts.push({ t: c.t, id }); return id; }
            }
            return null;
        };
        // ---- 2. junctions: segment ends that meet another segment, and crossings
        for (const s of S) for (const end of [s.a, s.b]) {
            const id = addNode(f.id, end[0], end[1]);
            s.pts.push({ t: end === s.a ? 0 : 1, id });
            for (const o of S) {
                if (o === s) continue;
                const pr = proj(o, end), d = D(end, pr.p);
                if (d <= 3 && los(f, end, pr.p)) { const j = addNode(f.id, pr.p[0], pr.p[1]); o.pts.push({ t: pr.t, id: j }); addEdge(id, j); }
            }
        }
        for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
            const s = S[i], o = S[j];
            const d1 = [s.b[0] - s.a[0], s.b[1] - s.a[1]], d2 = [o.b[0] - o.a[0], o.b[1] - o.a[1]];
            const den = d1[0] * d2[1] - d1[1] * d2[0];
            if (Math.abs(den) < 1e-9) continue;
            const t = ((o.a[0] - s.a[0]) * d2[1] - (o.a[1] - s.a[1]) * d2[0]) / den;
            const u = ((o.a[0] - s.a[0]) * d1[1] - (o.a[1] - s.a[1]) * d1[0]) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const id = addNode(f.id, s.a[0] + d1[0] * t, s.a[1] + d1[1] * t);
            s.pts.push({ t, id }); o.pts.push({ t: u, id });
        }
        // ---- 3. doorways of every room (gaps in its walls)
        const looseEnds = [];
        let doorCount = 0;
        for (const p of plist) {
            if (p.floor !== f || !p.isRoom || !p.floors.length) continue;
            const contacts = [];
            for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
                const i = z * g.nx + x;
                if (g.owner[i] !== p.index || g.blocked[i]) continue;
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const X = x + dx, Z = z + dz;
                    if (X < 0 || Z < 0 || X >= g.nx || Z >= g.nz) continue;
                    const j = Z * g.nx + X;
                    if (g.owner[j] === p.index || !passable(g, j)) continue;
                    contacts.push({ x: g.ox + (x + 0.5 + dx / 2) * 0.2, z: g.oz + (z + 0.5 + dz / 2) * 0.2, dx, dz });
                }
            }
            // group contacts along the same wall into openings
            const groups = [];
            for (const c of contacts) {
                const gr = groups.find(G => G.dx === c.dx && G.dz === c.dz && G.items.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 0.45));
                if (gr) gr.items.push(c); else groups.push({ dx: c.dx, dz: c.dz, items: [c] });
            }
            for (let k = 0; k < groups.length; k++) for (let m = k + 1; m < groups.length; m++) {   // merge chains
                const A = groups[k], B = groups[m];
                if (A && B && A.dx === B.dx && A.dz === B.dz && A.items.some(a => B.items.some(b => Math.hypot(a.x - b.x, a.z - b.z) < 0.45))) { A.items.push(...B.items); groups[m] = null; }
            }
            const openings = groups.filter(G => G && G.items.length >= 3 && G.items.length <= 45);
            for (const G of openings) {
                const mx = G.items.reduce((s, c) => s + c.x, 0) / G.items.length, mz = G.items.reduce((s, c) => s + c.z, 0) / G.items.length;
                const inside = [mx - G.dx * 0.6, mz - G.dz * 0.6], outside = [mx + G.dx * 0.6, mz + G.dz * 0.6];
                const allow = new Set([p.index]);
                const oc = cell(g, outside[0], outside[1]);
                if (!passable(g, oc)) continue;
                if (g.owner[oc] >= 0) allow.add(g.owner[oc]);
                if (!los(f, inside, outside, allow)) continue;
                const a = addNode(f.id, inside[0], inside[1]), b = addNode(f.id, outside[0], outside[1]);
                addEdge(a, b);
                roomInside.add(a);
                doorCount++;
                const h = attachTo(outside, 15, allow);
                if (h) addEdge(b, h); else looseEnds.push({ id: b, p: outside, allow, room: p.raw });
            }
            if (!openings.length) log.push(`F${f.id} ${p.raw}: no doorway found`);
        }
        // ---- 4. stairs (one landing point per end, linked across floors)
        f._attach = attachTo; f._loose = looseEnds; f._segs = S; f._doors = doorCount;
    }
    const seenStair = new Set();
    for (const [from, list] of portals) for (const e of list) {
        const key = e.stair.key + '|' + Math.min(from, e.to);
        if (seenStair.has(e.stair.key)) continue;
        const fa = floors.find(f => from >= f.offset && from < f.offset + f.grid.nx * f.grid.nz);
        const fb = floors.find(f => e.to >= f.offset && e.to < f.offset + f.grid.nx * f.grid.nz);
        const ca = from - fa.offset, cb = e.to - fb.offset;
        const pa = [fa.grid.ox + (ca % fa.grid.nx + 0.5) * 0.2, fa.grid.oz + (Math.floor(ca / fa.grid.nx) + 0.5) * 0.2];
        const pb = [fb.grid.ox + (cb % fb.grid.nx + 0.5) * 0.2, fb.grid.oz + (Math.floor(cb / fb.grid.nx) + 0.5) * 0.2];
        // move a landing that falls on a wall to the nearest walkable spot
        const nudge = (f, p) => {
            const g = f.grid;
            if (passable(g, cell(g, p[0], p[1]))) return p;
            for (let r = 1; r <= 8; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
                const q = [p[0] + dx * 0.2, p[1] + dz * 0.2];
                if (passable(g, cell(g, q[0], q[1]))) return q;
            }
            return p;
        };
        pa.splice(0, 2, ...nudge(fa, pa)); pb.splice(0, 2, ...nudge(fb, pb));
        const a = addNode(fa.id, pa[0], pa[1]), b = addNode(fb.id, pb[0], pb[1]);
        addEdge(a, b);
        seenStair.add(e.stair.key);
        for (const [f, p, id] of [[fa, pa, a], [fb, pb, b]]) {
            const own = f.grid.owner[cell(f.grid, p[0], p[1])];
            const allow = new Set(own >= 0 ? [own] : []);   // a stair may stand inside a room or hall
            const h = f._attach(p, 15, allow);
            if (h) addEdge(id, h); else f._loose.push({ id, p, allow, room: 'stair ' + e.stair.raw, stair: true });
        }
        log.push(`stair ${e.stair.raw}: F${fa.id} ↔ F${fb.id}`);
    }
    // ---- 5. chain each hallway's points in order
    for (const f of floors) for (const s of f._segs) {
        s.pts.sort((u, v) => u.t - v.t);
        for (let k = 0; k < s.pts.length - 1; k++) addEdge(s.pts[k].id, s.pts[k + 1].id);
    }
    // ---- 6. loose ends: join to the nearest visible point
    for (const f of floors) for (const le of f._loose) {
        const cands = nodes.filter(n => n.f === f.id && n.id !== le.id).map(n => ({ n, d: Math.hypot(n.x - le.p[0], n.z - le.p[1]) })).sort((u, v) => u.d - v.d);
        const hit = cands.find(c => c.d < 12 && los(f, le.p, [c.n.x, c.n.z], le.allow))
            || (le.stair && cands.find(c => c.d < 3.5 && los(f, le.p, [c.n.x, c.n.z], le.allow, true)));   // a flight may cross open air
        if (hit) addEdge(le.id, hit.n.id); else log.push(`F${f.id} ${le.room}: doorway not connected`);
    }
    // ---- 6b. cross-links: nearby hallway points with a clear walking line between them
    let cross = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (a.f !== b.f || roomInside.has(a.id) || roomInside.has(b.id)) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > 6.5 || d < 0.3) continue;
        const k = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        if (edges.has(k)) continue;
        if (los(floors.find(F => F.id === a.f), [a.x, a.z], [b.x, b.z])) { edges.add(k); cross++; }
    }
    log.push(`cross-links: ${cross}`);
    // ---- 7. stitch islands (e.g. a door between two rooms) onto the rest of the network
    const ownerAt = n => { const f = floors.find(F => F.id === n.f); return f.grid.owner[cell(f.grid, n.x, n.z)]; };
    for (let pass = 0; pass < 60; pass++) {
        const adj = new Map(nodes.map(n => [n.id, []]));
        for (const e of edges) { const [a, b] = e.split('-').map(Number); adj.get(a).push(b); adj.get(b).push(a); }
        const comp = new Map(), sizes = [];
        for (const n of nodes) {
            if (comp.has(n.id)) continue;
            const q = [n.id]; comp.set(n.id, sizes.length); let c = 0;
            while (q.length) { const x = q.pop(); c++; for (const y of adj.get(x)) if (!comp.has(y)) { comp.set(y, sizes.length); q.push(y); } }
            sizes.push(c);
        }
        const main = sizes.indexOf(Math.max(...sizes));
        let joined = 0;
        for (let ci = 0; ci < sizes.length; ci++) {
            if (ci === main) continue;
            const mine = nodes.filter(n => comp.get(n.id) === ci);
            let best = null;
            for (const a of mine) for (const b of nodes) {
                if (b.f !== a.f || comp.get(b.id) === ci) continue;
                const d = Math.hypot(a.x - b.x, a.z - b.z) + (comp.get(b.id) === main ? 0 : 3);   // prefer the main network
                if (d > 9 || (best && d >= best.d)) continue;
                const f = floors.find(F => F.id === a.f);
                const allow = new Set([ownerAt(a), ownerAt(b)].filter(o => o >= 0));
                if (los(f, [a.x, a.z], [b.x, b.z], allow)) best = { a, b, d };
            }
            if (best) { addEdge(best.a.id, best.b.id); joined++; }
        }
        if (!joined) { log.push(`islands left: ${sizes.length - 1} (${sizes.filter((_, i) => i !== main).join(',')} points)`); break; }
    }
    for (const f of floors) log.push(`F${f.id}: ${f._segs.length} hallway lines, ${f._doors} doorways`);
    return { nodes, edges: [...edges].map(s => s.split('-').map(Number)), log };
}, MANUAL, [...SKIP_AUTO]);

console.log(result.log.join('\n'));
const file = JSON.parse(fs.readFileSync(OUT, 'utf8'));
file.main = { nodes: result.nodes, edges: result.edges };
fs.writeFileSync(OUT, JSON.stringify(file, null, 1));
console.log(`wrote ${result.nodes.length} points, ${result.edges.length} lines`);
await browser.close();
