// Campus switch + the route between the two campuses.
// The route shown on the small map is drawn by hand (campus-route.json), not worked out by Google,
// because Google's route between the campuses is wrong. Draw / fix it at map.html?editroute=1.
// The "From main campus" / "From my location" buttons still open Google Maps for turn-by-turn navigation.
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

    const ll = p => `${p.lat},${p.lng}`;
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

    // Opens Google Maps (the app on phones) with the route ready to start.
    // Without an origin, Google Maps starts from the user's current location.
    function directionsUrl(mode, from) {
        const q = new URLSearchParams({ api: '1', destination: ll(there.pos), travelmode: mode });
        if (from) q.set('origin', ll(from));
        return `https://www.google.com/maps/dir/?${q}`;
    }

    /* ---------- state ---------- */
    let mode = 'walking';
    let routes = { walking: [], driving: [] };   // points as {lat, lng}, main campus → Agri Lab
    let saved = '';                              // JSON of the last saved/loaded routes (for "unsaved" warnings)
    let undo = [];
    let map = null, line = null, straight = null, pointLayer = null;
    let editor = null;                           // the drawing tools (map.html?editroute=1)

    $('campus2Title').textContent = there.name;
    $('campus2Map').setAttribute('aria-label', `Map of the route from the ${lower(here)} to the ${lower(there)}`);
    $('campus2FromMain').textContent = site === 'agri' ? 'From the Agri Lab' : 'From main campus';

    function setMode(m) {
        mode = m;
        document.querySelectorAll('.campus2 .mode-switch button').forEach(b => {
            const on = b.dataset.mode === m;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on);
        });
        $('campus2FromMain').href = directionsUrl(m, here.pos);
        $('campus2FromHere').href = directionsUrl(m, null);
        draw();
    }
    document.querySelectorAll('.campus2 .mode-switch button').forEach(b =>
        b.addEventListener('click', () => setMode(b.dataset.mode)));

    /* ---------- "From my location": needs the device's location (GPS) ---------- */
    // Rather than letting Google Maps guess where the person is, ask the device for a precise fix
    // (GPS where available) and give Google that exact starting point.
    const GOOD_ACCURACY_M = 25;      // stop waiting once the fix is this accurate
    const MAX_WAIT_MS = 15000;       // …or after this long, using the best fix so far
    const ROUGH_ACCURACY_M = 100;    // worse than this: warn that the location is approximate
    const fromHere = $('campus2FromHere');
    const locStatus = $('campus2LocStatus');
    let locating = false, myMarker = null, myCircle = null;

    function showLoc(html, warn = false) {
        locStatus.innerHTML = html;
        locStatus.classList.toggle('warn', warn);
        locStatus.hidden = !html;
    }
    const HOW_TO_ENABLE =
        'Turn on <strong>Location</strong> (GPS) on your phone, then allow location for this site: tap the icon ' +
        'next to the web address, choose <strong>Permissions → Location → Allow</strong>, and try again. ' +
        'On iPhone, also check <strong>Settings → Privacy → Location Services</strong> for your browser ' +
        '(with <strong>Precise Location</strong> on).';

    // Watches the position for a few seconds and keeps the most accurate reading
    // (the first fix often comes from Wi-Fi or cell towers; GPS sharpens it).
    function locate() {
        return new Promise((resolve, reject) => {
            let best = null;
            const finish = () => {
                navigator.geolocation.clearWatch(watch);
                clearTimeout(timer);
                best ? resolve(best) : reject({ code: 3 });
            };
            const watch = navigator.geolocation.watchPosition(pos => {
                if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
                showLoc(`Finding your location… (accurate to about ${Math.round(best.coords.accuracy)} m so far)`);
                if (best.coords.accuracy <= GOOD_ACCURACY_M) finish();
            }, err => {
                if (err.code === 1 || !best) { navigator.geolocation.clearWatch(watch); clearTimeout(timer); reject(err); }
            }, { enableHighAccuracy: true, maximumAge: 0, timeout: MAX_WAIT_MS });
            const timer = setTimeout(finish, MAX_WAIT_MS);
        });
    }

    function showMeOnMap(pos) {
        if (!map) return;
        const L = window.L, at = [pos.coords.latitude, pos.coords.longitude];
        if (!myMarker) {
            myCircle = L.circle(at, { radius: pos.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
            myMarker = L.marker(at, { icon: L.divIcon({ className: 'campus2-me', iconSize: [16, 16] }), keyboard: false, zIndexOffset: 2000 })
                .bindTooltip('You are here', { direction: 'top', offset: [0, -8] }).addTo(map);
        } else {
            myMarker.setLatLng(at);
            myCircle.setLatLng(at).setRadius(pos.coords.accuracy);
        }
        map.fitBounds(L.latLngBounds([at, there.pos]), { padding: [28, 28], maxZoom: 17 });
    }

    fromHere.addEventListener('click', async e => {
        e.preventDefault();
        if (locating) return;
        if (!window.isSecureContext || !('geolocation' in navigator)) {
            showLoc('This browser can’t share your location here. Open the site in Chrome or Safari ' +
                '(over <strong>https://</strong>) to get directions from where you are.', true);
            return;
        }
        try {
            const perm = await navigator.permissions?.query({ name: 'geolocation' });
            if (perm?.state === 'denied') { showLoc(`Location is blocked for this site. ${HOW_TO_ENABLE}`, true); return; }
        } catch { /* Permissions API not available: just ask */ }

        locating = true;
        const label = fromHere.textContent;
        fromHere.textContent = 'Finding you…';
        fromHere.classList.add('busy');
        showLoc('Allow location access when your browser asks, so the route starts from exactly where you are.');
        try {
            const pos = await locate();
            const acc = Math.round(pos.coords.accuracy);
            const url = directionsUrl(mode, { lat: pos.coords.latitude, lng: pos.coords.longitude });
            showMeOnMap(pos);
            fromHere.href = url;   // a second tap opens the same route
            const rough = acc > ROUGH_ACCURACY_M;
            const accText = rough
                ? `Your location is only approximate (about ${acc} m). For a more accurate start, turn on GPS / ` +
                  '<strong>Precise Location</strong> and tap again.'
                : `Location found (accurate to about ${acc} m).`;
            // Browsers block new tabs opened too long after the tap; if so, the button is ready to tap again.
            const win = window.open(url, '_blank');   // (not 'noopener': that always returns null)
            if (win) win.opener = null;
            showLoc(win === null
                ? `${accText} Tap <strong>From my location</strong> again to open the directions.`
                : `${accText} Opening Google Maps…`, rough);
            if (win === null) {
                // Next tap: open the prepared route straight away.
                const once = ev => { ev.stopImmediatePropagation(); fromHere.removeEventListener('click', once, true); setTimeout(() => setMode(mode), 0); };
                fromHere.addEventListener('click', once, true);
            } else {
                setTimeout(() => setMode(mode), 0);
            }
        } catch (err) {
            const msg = err.code === 1 ? `Location access was not allowed. ${HOW_TO_ENABLE}`
                : err.code === 3 ? 'Couldn’t find your location in time. Turn on <strong>Location</strong> (GPS), move near a window or outdoors, and try again.'
                : `Couldn’t get your location. ${HOW_TO_ENABLE}`;
            showLoc(msg, true);
        } finally {
            locating = false;
            fromHere.textContent = label;
            fromHere.classList.remove('busy');
        }
    });

    function updateMeta() {
        const pts = routes[mode];
        if (pts.length > 1) {
            const km = lengthKm(pts);
            const min = Math.max(1, Math.round(km / SPEED_KMH[mode] * 60));
            $('campus2Meta').textContent = `${km.toFixed(1)} km · about ${min} min ${mode === 'walking' ? 'walk' : 'drive'}`;
        } else {
            $('campus2Meta').textContent = `About ${distanceKm(here.pos, there.pos).toFixed(1)} km from here (straight line)`;
        }
        if (editing) updateEditor();
    }
    updateMeta();

    /* ---------- the small map (Leaflet, loaded once the 3D map is up so it doesn't slow that down) ---------- */
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

    let started = false;
    async function start() {
        if (started) return;
        started = true;
        try {
            await Promise.all([loadLeaflet(), loadRoutes()]);
        } catch (err) {
            console.warn('[campus route]', err);
            $('campus2Map').textContent = 'The map could not be loaded.';
            return;
        }
        saved = routesJson();
        const L = window.L;
        map = L.map('campus2Map', { zoomControl: true, attributionControl: true, scrollWheelZoom: editing });
        const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
        });
        const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        });
        (editing ? satellite : street).addTo(map);

        // Map / Satellite toggle
        const Toggle = L.Control.extend({
            onAdd() {
                const b = L.DomUtil.create('button', 'campus2-layer-btn');
                b.type = 'button';
                const label = () => (b.textContent = map.hasLayer(satellite) ? 'Map' : 'Satellite');
                label();
                L.DomEvent.disableClickPropagation(b);
                b.addEventListener('click', () => {
                    const [off, on] = map.hasLayer(satellite) ? [satellite, street] : [street, satellite];
                    map.removeLayer(off);
                    on.addTo(map);
                    label();
                });
                return b;
            },
        });
        new Toggle({ position: 'topright' }).addTo(map);

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
    }

    function draw(fit = false) {
        updateMeta();
        if (!map) return;
        const pts = routes[mode];
        line.setLatLngs(pts);
        if (pts.length > 1) straight.remove(); else straight.addTo(map);
        if (editing) drawPoints();
        if (fit) {
            const bounds = window.L.latLngBounds([here.pos, there.pos, ...pts]);
            map.fitBounds(bounds, { padding: [24, 24] });
        }
    }

    // The 3D map tells us when it has finished loading; fall back to a timer in case it can't load.
    window.addEventListener('campusmap:ready', start);
    setTimeout(start, editing ? 0 : 30000);

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
        const card = document.querySelector('.campus2');
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
