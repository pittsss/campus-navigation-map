// Campus switch + the route between the two campuses, on a Leaflet map (no Google Maps).
// The route is drawn by hand (campus-route.json) because Google's route between the campuses is wrong;
// draw / fix it at map.html?editroute=1. "From my location" follows the person's GPS position along
// that route live, with the distance and time left.
(function () {
    const CAMPUSES = {
        main: {
            name: 'Main campus',
            subtitle: 'Batanes State College · Main Building',
            pos: { lat: 20.450983751626257, lng: 121.96859583684216 },
        },
        agri: {
            name: 'BSC Agricultural Laboratory',
            subtitle: 'BSC · Agricultural Laboratory',
            pos: { lat: 20.454265489133476, lng: 121.97410688505313 },
        },
    };
    const ROUTE_FILE = 'campus-route.json';   // { walking: [[lat, lng], …], driving: [[lat, lng], …] }, main campus → Agri Lab
    const SPEED_KMH = { walking: 4.5, driving: 25 };
    const MODES = ['walking', 'driving'];

    const params = new URLSearchParams(location.search);
    const site = params.get('site') === 'agri' ? 'agri' : 'main';
    const editing = params.has('editroute');
    const here = CAMPUSES[site];
    const there = CAMPUSES[site === 'agri' ? 'main' : 'agri'];

    const $ = id => document.getElementById(id);
    const lower = c => (c === CAMPUSES.main ? 'main campus' : c.name);

    // Page header + campus switch
    $('siteSubtitle').textContent = here.subtitle;
    if (site === 'agri') document.title = 'Agricultural Laboratory - BSC Campus Navigator';
    document.querySelectorAll('.site-switch a').forEach(a => {
        const on = a.dataset.site === site;
        a.classList.toggle('on', on);
        if (on) a.setAttribute('aria-current', 'page');
        if (editing) a.href += (a.href.includes('?') ? '&' : '?') + 'editroute=1';
    });

    function distanceKm(a, b) {
        const R = 6371, rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }
    const lengthKm = pts => pts.reduce((s, p, i) => i ? s + distanceKm(pts[i - 1], p) : 0, 0);
    const fmtDist = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
    const fmtMin = m => `about ${Math.max(1, Math.round(m / 1000 / SPEED_KMH[mode] * 60))} min`;

    /* ---------- state ---------- */
    let mode = 'walking';
    let routes = { walking: [], driving: [] };   // points as {lat, lng}, main campus → Agri Lab
    let saved = '';                              // JSON of the last saved/loaded routes (for "unsaved" warnings)
    let undo = [];
    let map = null, line = null, straight = null, pointLayer = null;
    let editor = null;                           // the drawing tools (map.html?editroute=1)

    const card = document.querySelector('.campus2');
    const showBtn = $('campus2FromMain');
    const navBtn = $('campus2FromHere');
    const locStatus = $('campus2LocStatus');

    $('campus2Title').textContent = there.name;
    $('campus2Map').setAttribute('aria-label', `Map of the route from the ${lower(here)} to the ${lower(there)}`);

    // The route as travelled from this page's campus (the file stores it main campus → Agri Lab).
    const trip = () => (site === 'agri' ? [...routes[mode]].reverse() : routes[mode]);

    function setMode(m) {
        if (nav) stopNav();
        mode = m;
        document.querySelectorAll('.campus2 .mode-switch button').forEach(b => {
            const on = b.dataset.mode === m;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on);
        });
        draw();
    }
    document.querySelectorAll('.campus2 .mode-switch button').forEach(b =>
        b.addEventListener('click', () => setMode(b.dataset.mode)));

    // Only offer a travel mode once its route has been drawn (all of them while drawing).
    function updateModeButtons() {
        document.querySelectorAll('.campus2 .mode-switch button').forEach(b => {
            b.hidden = !editing && b.dataset.mode !== 'walking' && routes[b.dataset.mode].length < 2;
        });
        const sw = document.querySelector('.campus2 .mode-switch');
        sw.hidden = [...sw.querySelectorAll('button')].filter(b => !b.hidden).length < 2;
    }

    function updateMeta() {
        const pts = routes[mode];
        if (pts.length > 1) {
            const m = lengthKm(pts) * 1000;
            $('campus2Meta').textContent = `${fmtDist(m)} · ${fmtMin(m)} ${mode === 'walking' ? 'walk' : 'drive'}`;
        } else {
            $('campus2Meta').textContent = `About ${distanceKm(here.pos, there.pos).toFixed(1)} km from here (straight line)`;
        }
        if (editing) updateEditor();
    }
    updateMeta();

    function showStatus(html, warn = false) {
        locStatus.innerHTML = html;
        locStatus.classList.toggle('warn', warn);
        locStatus.hidden = !html;
    }

    /* ---------- the map (Leaflet, loaded once the 3D map is up so it doesn't slow that down) ---------- */
    function loadLeaflet() {
        if (window.L) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = 'vendor/leaflet/leaflet.css';
            document.head.appendChild(css);
            const js = document.createElement('script');
            js.src = 'vendor/leaflet/leaflet.js';
            js.onload = resolve;
            js.onerror = () => reject(new Error('Leaflet failed to load'));
            document.head.appendChild(js);
        });
    }

    async function loadRoutes() {
        try {
            const res = await fetch(`${ROUTE_FILE}?v=${Date.now()}`, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            for (const m of MODES) {
                if (Array.isArray(data[m])) routes[m] = data[m].map(([lat, lng]) => ({ lat, lng }));
            }
        } catch { /* no route drawn yet */ }
    }
    // One point per line, so changes are easy to read in git.
    const routesJson = () => '{\n' + MODES.map(m =>
        ` "${m}": [` + routes[m].map(p => `\n  [${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}]`).join(',') + (routes[m].length ? '\n ]' : ']')
    ).join(',\n') + '\n}\n';

    let starting = null;
    function start() {
        return (starting ||= (async () => {
            try {
                await Promise.all([loadLeaflet(), loadRoutes()]);
            } catch (err) {
                console.warn('[campus route]', err);
                $('campus2Map').textContent = 'The map could not be loaded.';
                throw err;
            }
            saved = routesJson();
            updateModeButtons();
            const L = window.L;
            map = L.map('campus2Map', { zoomControl: true, attributionControl: true, scrollWheelZoom: editing });
            const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
            });
            const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
            });
            (editing ? satellite : street).addTo(map);

            const button = (cls, onClick) => {
                const b = L.DomUtil.create('button', cls);
                b.type = 'button';
                L.DomEvent.disableClickPropagation(b);
                b.addEventListener('click', onClick);
                return b;
            };
            // Map / Satellite toggle
            const layerBtn = button('campus2-layer-btn', () => {
                const [off, on] = map.hasLayer(satellite) ? [satellite, street] : [street, satellite];
                map.removeLayer(off);
                on.addTo(map);
                layerBtn.textContent = map.hasLayer(satellite) ? 'Map' : 'Satellite';
            });
            layerBtn.textContent = map.hasLayer(satellite) ? 'Map' : 'Satellite';
            // Full screen (handy while walking with a phone)
            const fullBtn = button('campus2-layer-btn', () => setFullscreen(!card.classList.contains('fullscreen')));
            fullBtn.textContent = 'Full screen';
            fullBtn.dataset.role = 'fullscreen';
            const Controls = L.Control.extend({
                onAdd() {
                    const box = L.DomUtil.create('div', 'campus2-map-controls');
                    box.append(layerBtn, ...(editing ? [] : [fullBtn]));
                    return box;
                },
            });
            new Controls({ position: 'topright' }).addTo(map);

            const pin = (c, cls) => L.marker(c.pos, {
                icon: L.divIcon({ className: `campus2-pin ${cls}`, iconSize: [16, 16] }),
                keyboard: false, zIndexOffset: 1000,
            }).bindTooltip(c === here ? `${c.name} (you are here)` : c.name, { direction: 'top', offset: [0, -8] }).addTo(map);
            const pins = [pin(here, 'start'), pin(there, 'end')];
            // While drawing, clicking a campus pin adds a point exactly on it.
            if (editing) pins.forEach((p, i) => p.on('click', () => change(() => routes[mode].push(L.latLng((i ? there : here).pos)))));

            line = L.polyline([], { color: '#08733b', weight: 5, opacity: 0.9, lineJoin: 'round', bubblingMouseEvents: false }).addTo(map);
            straight = L.polyline([here.pos, there.pos], { color: '#5c7366', weight: 2, dashArray: '6 6', interactive: false }).addTo(map);
            pointLayer = L.layerGroup().addTo(map);

            if (editing) setupEditor(L);
            new ResizeObserver(() => map.invalidateSize()).observe($('campus2Map'));
            draw(true);
        })());
    }

    function draw(fit = false) {
        updateMeta();
        if (!map) return;
        const pts = routes[mode];
        line.setLatLngs(pts);
        if (pts.length > 1) straight.remove(); else straight.addTo(map);
        if (editing) drawPoints();
        if (fit) fitRoute();
    }
    const fitRoute = () => map.fitBounds(window.L.latLngBounds([here.pos, there.pos, ...routes[mode]]), { padding: [24, 24] });

    // The 3D map tells us when it has finished loading; fall back to a timer in case it can't load.
    window.addEventListener('campusmap:ready', () => start().catch(() => {}));
    setTimeout(() => start().catch(() => {}), editing ? 0 : 30000);

    function setFullscreen(on) {
        card.classList.toggle('fullscreen', on);
        document.body.classList.toggle('campus2-fullscreen', on);
        const b = card.querySelector('[data-role="fullscreen"]');
        if (b) b.textContent = on ? 'Exit full screen' : 'Full screen';
        if (map) setTimeout(() => map.invalidateSize(), 50);
    }
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && card.classList.contains('fullscreen')) setFullscreen(false);
    });

    /* =========================================================
       DIRECTIONS ON THE MAP
    ========================================================= */
    showBtn.textContent = 'Show route';
    showBtn.addEventListener('click', async () => {
        try { await start(); } catch { return; }
        if (nav) stopNav();
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        fitRoute();
        const pts = routes[mode];
        showStatus(pts.length > 1
            ? `Follow the green line from the ${lower(here)} (green pin) to the ${lower(there)} (red pin): ` +
              `<strong>${fmtDist(lengthKm(pts) * 1000)}</strong>, ${fmtMin(lengthKm(pts) * 1000)}.`
            : 'The route hasn’t been drawn yet; the dashed line shows the direction only.');
    });

    /* ---------- "From my location": live directions along the drawn route, using the device's GPS ---------- */
    const ARRIVED_M = 30;          // this close to the destination = arrived
    const OFF_ROUTE_M = 40;        // further than this from the line = show the way back to it
    const ROUGH_ACCURACY_M = 100;  // worse than this: warn that the location is approximate
    const HOW_TO_ENABLE =
        'Turn on <strong>Location</strong> (GPS) on your phone, then allow location for this site: tap the icon ' +
        'next to the web address, choose <strong>Permissions → Location → Allow</strong>, and try again. ' +
        'On iPhone, also check <strong>Settings → Privacy → Location Services</strong> for your browser ' +
        '(with <strong>Precise Location</strong> on).';

    let nav = null;   // { watch, layers, progress, follow, wakeLock, firstFix }

    // Metres in a flat frame around the route (accurate enough over a few km).
    const toXY = (p, o) => ({ x: (p.lng - o.lng) * 111320 * Math.cos(o.lat * Math.PI / 180), y: (p.lat - o.lat) * 110540 });

    // Closest point on the route to `p`: { at: {lat,lng}, seg, along (m from start), off (m from the line) }.
    // Prefers spots at or past the progress made so far, so a route that doubles back doesn't jump backwards.
    function snap(pts, p, progress) {
        const o = pts[0], q = toXY(p, o), xy = pts.map(v => toXY(v, o));
        let walked = 0, best = null, ahead = null;
        for (let i = 1; i < xy.length; i++) {
            const a = xy[i - 1], b = xy[i], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
            const t = len ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (len * len))) : 0;
            const x = a.x + t * dx, y = a.y + t * dy;
            const c = {
                seg: i, along: walked + t * len, off: Math.hypot(q.x - x, q.y - y),
                at: { lat: pts[i - 1].lat + t * (pts[i].lat - pts[i - 1].lat), lng: pts[i - 1].lng + t * (pts[i].lng - pts[i - 1].lng) },
            };
            if (!best || c.off < best.off) best = c;
            if (c.along >= progress - 30 && (!ahead || c.off < ahead.off)) ahead = c;
            walked += len;
        }
        return ahead && ahead.off <= best.off + 20 ? ahead : best;
    }

    function stopNav(message) {
        if (!nav) return;
        navigator.geolocation.clearWatch(nav.watch);
        nav.layers.forEach(l => l.remove());
        nav.wakeLock?.release?.().catch(() => {});
        nav = null;
        line.setStyle({ opacity: 0.9 });
        navBtn.textContent = 'From my location';
        navBtn.classList.remove('busy', 'stop');
        showStatus(message || '');
    }

    function onPosition(pos) {
        const L = window.L;
        const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const acc = Math.round(pos.coords.accuracy);
        let pts = trip();
        if (pts.length < 2) pts = [here.pos, there.pos];   // no route drawn: straight towards the destination

        const s = snap(pts, me, nav.progress);
        nav.progress = Math.max(nav.progress, s.along);
        const total = lengthKm(pts) * 1000;
        const toGoRoute = Math.max(0, total - s.along);
        const toGo = toGoRoute + (s.off > OFF_ROUTE_M ? s.off : 0);
        const atDest = distanceKm(me, there.pos) * 1000;

        // Route split at the person's spot: done (grey) and still to go (green); dashed blue back to the line.
        const [dot, ring, done, left, back] = nav.layers;
        dot.setLatLng(me);
        ring.setLatLng(me).setRadius(pos.coords.accuracy);
        done.setLatLngs([...pts.slice(0, s.seg), s.at]);
        left.setLatLngs([s.at, ...pts.slice(s.seg)]);
        back.setLatLngs(s.off > 10 ? [me, s.at] : []);

        if (nav.firstFix) {
            nav.firstFix = false;
            map.fitBounds(L.latLngBounds([me, s.at, there.pos]), { padding: [36, 36], maxZoom: 18 });
        } else if (nav.follow) {
            map.panTo(me, { animate: true });
        }

        if (atDest <= ARRIVED_M || (toGoRoute <= ARRIVED_M && s.off <= OFF_ROUTE_M)) {
            stopNav(`<strong>You’ve arrived</strong> at the ${lower(there)}.`);
            return;
        }
        const parts = [`<strong>${fmtDist(toGo)}</strong> to the ${lower(there)} · ${fmtMin(toGo)}`];
        if (s.off > OFF_ROUTE_M) parts.push(`You’re about ${fmtDist(s.off)} from the route: head to the green line (dashed blue).`);
        else parts.push('Keep following the green line.');
        if (acc > ROUGH_ACCURACY_M) parts.push(`Your location is only approximate (about ${acc} m). Turn on GPS / <strong>Precise Location</strong> for a more accurate position.`);
        else parts.push(`<span class="campus2-acc">Location accurate to about ${acc} m.</span>`);
        showStatus(parts.join('<br>'), acc > ROUGH_ACCURACY_M || s.off > OFF_ROUTE_M);
    }

    navBtn.addEventListener('click', async e => {
        e.preventDefault();
        if (nav) { stopNav(); return; }
        if (!window.isSecureContext || !('geolocation' in navigator)) {
            showStatus('This browser can’t share your location here. Open the site in Chrome or Safari ' +
                '(over <strong>https://</strong>) to get directions from where you are.', true);
            return;
        }
        try {
            const perm = await navigator.permissions?.query({ name: 'geolocation' });
            if (perm?.state === 'denied') { showStatus(`Location is blocked for this site. ${HOW_TO_ENABLE}`, true); return; }
        } catch { /* Permissions API not available: just ask */ }
        try { await start(); } catch { return; }

        const L = window.L;
        nav = {
            progress: 0, follow: true, firstFix: true, wakeLock: null,
            layers: [
                L.marker(here.pos, { icon: L.divIcon({ className: 'campus2-me', iconSize: [18, 18] }), keyboard: false, zIndexOffset: 2000, interactive: false }),
                L.circle(here.pos, { radius: 0, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }),
                L.polyline([], { color: '#8a9a90', weight: 5, opacity: 0.8, lineJoin: 'round', interactive: false }),
                L.polyline([], { color: '#08733b', weight: 7, opacity: 1, lineJoin: 'round', interactive: false }),
                L.polyline([], { color: '#1a73e8', weight: 3, dashArray: '6 7', interactive: false }),
            ],
        };
        line.setStyle({ opacity: 0 });
        navBtn.textContent = 'Finding you…';
        navBtn.classList.add('busy');
        showStatus('Allow location access when your browser asks, so the directions start from exactly where you are.');
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        if (window.matchMedia('(max-width: 820px)').matches) setFullscreen(true);
        map.once('dragstart', () => nav && (nav.follow = false));   // stop following once the person moves the map
        try { nav.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* screen may still turn off */ }

        let added = false;
        nav.watch = navigator.geolocation.watchPosition(pos => {
            if (!nav) return;
            if (!added) {
                added = true;
                nav.layers.slice().reverse().forEach(l => l.addTo(map));
                navBtn.textContent = 'Stop';
                navBtn.classList.remove('busy');
                navBtn.classList.add('stop');
            }
            onPosition(pos);
        }, err => {
            if (!nav) return;
            // Already going and the signal drops for a moment (slow or no GPS update): keep the last
            // position and wait for the next one. Only a withdrawn permission stops the directions.
            if (added && err.code !== 1) {
                locStatus.querySelector('.campus2-acc')?.replaceChildren('Waiting for a GPS signal…');
                return;
            }
            stopNav();
            showStatus(err.code === 1 ? `Location access was not allowed. ${HOW_TO_ENABLE}`
                : err.code === 3 ? 'Couldn’t find your location in time. Turn on <strong>Location</strong> (GPS), move near a window or outdoors, and try again.'
                : `Couldn’t get your location. ${HOW_TO_ENABLE}`, true);
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    });

    /* =========================================================
       ROUTE EDITOR (map.html?editroute=1)
    ========================================================= */
    function change(fn) {
        undo.push(JSON.stringify(routes));
        if (undo.length > 200) undo.shift();
        fn();
        draw();
    }

    function drawPoints() {
        const L = window.L;
        pointLayer.clearLayers();
        routes[mode].forEach((p, i) => {
            const last = i === routes[mode].length - 1;
            const m = L.marker(p, {
                draggable: true, keyboard: false,
                icon: L.divIcon({ className: `campus2-vertex${i === 0 ? ' first' : ''}${last ? ' last' : ''}`, iconSize: [14, 14] }),
            }).addTo(pointLayer);
            m.bindTooltip(i === 0 ? 'Start (main campus end)' : last ? 'End (Agri Lab end)' : `Point ${i + 1} — drag to move, click to delete`,
                { direction: 'top', offset: [0, -8] });
            let before = null;
            m.on('dragstart', () => (before = JSON.stringify(routes)));
            m.on('drag', e => {
                routes[mode][i] = e.target.getLatLng();
                line.setLatLngs(routes[mode]);
            });
            m.on('dragend', e => {
                undo.push(before);
                routes[mode][i] = e.target.getLatLng();
                draw();
            });
            m.on('click', () => change(() => routes[mode].splice(i, 1)));
        });
    }

    // Index of the segment of the line nearest to a point (for inserting a point by clicking on the line).
    function nearestSegment(latlng) {
        const pts = routes[mode].map(p => map.latLngToLayerPoint(p));
        const q = map.latLngToLayerPoint(latlng);
        let best = 0, bestD = Infinity;
        for (let i = 1; i < pts.length; i++) {
            const d = window.L.LineUtil.pointToSegmentDistance(q, pts[i - 1], pts[i]);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }

    function setupEditor() {
        card.classList.add('editing');
        editor = document.createElement('div');
        editor.className = 'campus2-editor';
        editor.innerHTML = `
            <p class="campus2-help"><strong>Drawing the ${'<span class="ce-mode"></span>'} route.</strong>
                Click along the real route, starting at the main campus (click a campus pin to start or end exactly on it).
                Click the line to add a point in between, drag a point to move it, click a point to delete it.
                Use <em>Satellite</em> to see paths that aren't on the map.</p>
            <div class="campus2-tools">
                <button type="button" class="btn ghost small" data-act="undo">Undo</button>
                <button type="button" class="btn ghost small" data-act="reverse" title="Flip the direction of the line">Reverse</button>
                <button type="button" class="btn ghost small" data-act="clear">Clear</button>
                <button type="button" class="btn primary small" data-act="save">Save</button>
            </div>
            <p class="campus2-status" aria-live="polite"></p>`;
        $('campus2Map').after(editor);

        map.on('click', e => change(() => routes[mode].push(e.latlng)));
        line.on('click', e => {
            window.L.DomEvent.stop(e);
            change(() => routes[mode].splice(nearestSegment(e.latlng), 0, e.latlng));
        });

        editor.addEventListener('click', e => {
            const act = e.target.dataset?.act;
            if (act === 'undo' && undo.length) { routes = JSON.parse(undo.pop()); draw(); }
            if (act === 'reverse') change(() => routes[mode].reverse());
            if (act === 'clear' && routes[mode].length && confirm(`Delete the whole ${mode} route?`)) change(() => (routes[mode] = []));
            if (act === 'save') save();
        });
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && undo.length && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
                e.preventDefault();
                routes = JSON.parse(undo.pop());
                draw();
            }
        });
        window.addEventListener('beforeunload', e => {
            if (routesJson() !== saved) { e.preventDefault(); e.returnValue = ''; }
        });
    }

    function updateEditor() {
        if (!editor) return;
        editor.querySelector('.ce-mode').textContent = mode === 'walking' ? 'walking' : 'driving';
        editor.querySelector('[data-act="undo"]').disabled = !undo.length;
        const dirty = routesJson() !== saved;
        const status = editor.querySelector('.campus2-status');
        if (!status.dataset.sticky || dirty) {
            status.dataset.sticky = '';
            status.textContent = `${routes[mode].length} points` + (dirty ? ' · unsaved changes' : '');
        }
    }

    async function save() {
        const status = editor.querySelector('.campus2-status');
        const body = routesJson();
        try {
            const res = await fetch('/api/campus-route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            if (!res.ok) throw new Error(await res.text());
            saved = body;
            status.textContent = `Saved to ${ROUTE_FILE} ✓ — commit and push it to publish.`;
        } catch {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
            a.download = ROUTE_FILE;
            a.click();
            URL.revokeObjectURL(a.href);
            saved = body;
            status.textContent = `Couldn’t save here — downloaded ${ROUTE_FILE} instead. Put it in the project folder.`;
        }
        status.dataset.sticky = '1';
        updateEditor();
    }

    setMode('walking');
})();
