// Campus switch + the routes between the two campuses, on a Leaflet map (no Google Maps).
// Routes come from two places:
//   - drawn by hand (campus-route.json; draw / fix them at map.html?editroute=1) — any number per travel mode;
//   - suggested from OpenStreetMap roads and paths (osm-routes.json, made by tools/fetch-osm-routes.mjs).
// The list under the map marks the shortest. "From my location" follows the person's GPS position live
// along whichever route is shortest from where they are, with the distance and time left.
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
    // campus-route.json: { walking: [route, …], driving: [route, …] }, each route [[lat, lng], …] from the
    // main campus to the Agri Lab. (Older files with a single route per mode are read too.)
    const ROUTE_FILE = 'campus-route.json';
    const OSM_FILE = 'osm-routes.json';
    const SPEED_KMH = { walking: 4.5, driving: 25 };
    const MODES = ['walking', 'driving'];

    const params = new URLSearchParams(location.search);
    const site = params.get('site') === 'agri' ? 'agri' : 'main';
    const editing = params.has('editroute');
    const here = CAMPUSES[site];
    const there = CAMPUSES[site === 'agri' ? 'main' : 'agri'];

    const $ = id => document.getElementById(id);
    const lower = c => (c === CAMPUSES.main ? 'main campus' : c.name);
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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
    const lengthM = pts => pts.reduce((s, p, i) => i ? s + distanceKm(pts[i - 1], p) * 1000 : 0, 0);
    const fmtDist = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
    const fmtMin = m => `about ${Math.max(1, Math.round(m / 1000 / SPEED_KMH[mode] * 60))} min`;

    /* ---------- state ---------- */
    let mode = 'walking';
    let routes = { walking: [[]], driving: [[]] };   // hand-drawn routes per mode, each a list of {lat, lng}
    let osm = { walking: [], driving: [] };          // OpenStreetMap suggestions: { pts, gapEnd, gapStart }
    let cur = 0;                                     // the drawn route being edited
    let picked = null;                               // id of the route the person tapped (null: the shortest)
    let saved = '';                                  // JSON of the last saved/loaded routes (for "unsaved" warnings)
    let undo = [];
    let map = null, line = null, straight = null, pointLayer = null, otherLayer = null;
    let editor = null;                               // the drawing tools (map.html?editroute=1)
    let nav = null;                                  // live directions, see below

    const card = document.querySelector('.campus2');
    const showBtn = $('campus2FromMain');
    const navBtn = $('campus2FromHere');
    const locStatus = $('campus2LocStatus');
    const routeList = $('campus2Routes');

    $('campus2Title').textContent = there.name;
    $('campus2Map').setAttribute('aria-label', `Map of the routes from the ${lower(here)} to the ${lower(there)}`);

    // Every route for the current travel mode, oriented from this page's campus, shortest first.
    // { id, kind: 'drawn' | 'osm', name, pts, len, note }
    function options() {
        const list = [];
        const drawn = routes[mode].filter(r => r.length > 1);
        routes[mode].forEach((r, i) => {
            if (r.length > 1) list.push({ id: `d${i}`, kind: 'drawn', name: drawn.length > 1 ? `Route ${i + 1}` : 'Drawn route', pts: r });
        });
        osm[mode].forEach((r, i) => {
            // Join the suggestion to the campus pins (the mapped paths/roads stop short of them).
            const pts = [CAMPUSES.main.pos, ...r.pts, CAMPUSES.agri.pos];
            const gap = Math.max(r.gapStart, r.gapEnd);
            list.push({
                id: `o${i}`, kind: 'osm', name: osm[mode].length > 1 ? `OpenStreetMap ${i + 1}` : 'OpenStreetMap', pts,
                note: gap > 60 ? `last ${fmtDist(gap)} not on a mapped ${mode === 'driving' ? 'road' : 'path'}` : '',
            });
        });
        for (const o of list) {
            if (site === 'agri') o.pts = [...o.pts].reverse();
            o.len = lengthM(o.pts);
        }
        return list.sort((a, b) => a.len - b.len);
    }
    // The route shown in green: the one tapped, else the shortest drawn one (drawn routes are checked
    // on the ground), else the shortest suggestion.
    function selected(opts = options()) {
        return opts.find(o => o.id === picked) || opts.find(o => o.kind === 'drawn') || opts[0] || null;
    }

    function setMode(m) {
        if (nav) stopNav();
        mode = m;
        picked = null;
        cur = 0;
        document.querySelectorAll('.campus2 .mode-switch button').forEach(b => {
            const on = b.dataset.mode === m;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on);
        });
        draw(true);
    }
    document.querySelectorAll('.campus2 .mode-switch button').forEach(b =>
        b.addEventListener('click', () => setMode(b.dataset.mode)));

    // Only offer a travel mode once it has a route (all of them while drawing).
    function updateModeButtons() {
        document.querySelectorAll('.campus2 .mode-switch button').forEach(b => {
            const m = b.dataset.mode;
            b.hidden = !editing && m !== 'walking' && !routes[m].some(r => r.length > 1) && !osm[m].length;
        });
        const sw = document.querySelector('.campus2 .mode-switch');
        sw.hidden = [...sw.querySelectorAll('button')].filter(b => !b.hidden).length < 2;
    }

    function updateMeta() {
        const sel = editing ? null : selected();
        const pts = editing ? routes[mode][cur] : sel?.pts || [];
        if (pts.length > 1) {
            const m = lengthM(pts);
            $('campus2Meta').textContent = `${fmtDist(m)} · ${fmtMin(m)} ${mode === 'walking' ? 'walk' : 'drive'}`;
        } else {
            $('campus2Meta').textContent = `About ${distanceKm(here.pos, there.pos).toFixed(1)} km from here (straight line)`;
        }
        if (editing) updateEditor();
    }

    // The list of routes under the map (only when there's a choice).
    function renderRouteList() {
        const opts = editing ? [] : options();
        routeList.hidden = opts.length < 2;
        if (opts.length < 2) { routeList.innerHTML = ''; return; }
        const sel = nav?.option || selected(opts);
        routeList.innerHTML = '';
        opts.forEach((o, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'route-option' + (o.id === sel?.id ? ' on' : '');
            b.setAttribute('aria-pressed', o.id === sel?.id);
            const tags = [i === 0 ? 'Shortest' : `+${fmtDist(o.len - opts[0].len)}`,
                o.kind === 'osm' ? 'suggested by OpenStreetMap' : 'checked route', o.note].filter(Boolean);
            b.innerHTML = `<strong>${esc(o.name)}</strong><span>${fmtDist(o.len)} · ${fmtMin(o.len)}</span>` +
                `<span class="tag">${esc(tags.join(' · '))}</span>`;
            b.addEventListener('click', () => pick(o.id));
            routeList.appendChild(b);
        });
    }

    function pick(id) {
        picked = id;
        if (nav) { nav.only = id; nav.option = null; nav.lastPos && onPosition(nav.lastPos); }
        draw();
        const o = selected();
        if (!nav && o) showStatus(`<strong>${esc(o.name)}</strong>: ${fmtDist(o.len)}, ${fmtMin(o.len)}.` +
            (o.kind === 'osm' ? ' Suggested from OpenStreetMap roads and paths; not checked on the ground.' : ''));
    }

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

    const getJson = async file => {
        const res = await fetch(`${file}?v=${Date.now()}`, { cache: 'no-store' });
        return res.ok ? res.json() : null;
    };
    const toPts = list => list.map(([lat, lng]) => ({ lat, lng }));
    async function loadRoutes() {
        try {
            const data = await getJson(ROUTE_FILE);
            for (const m of MODES) {
                const v = data?.[m];
                if (!Array.isArray(v) || !v.length) continue;
                const single = typeof v[0]?.[0] === 'number';   // older file: one route per mode
                routes[m] = (single ? [v] : v).map(toPts);
            }
        } catch { /* no routes drawn yet */ }
        try {
            const data = await getJson(OSM_FILE);
            for (const m of MODES) {
                osm[m] = (data?.[m] || []).map(r => ({ pts: toPts(r.points), gapStart: r.gapStart || 0, gapEnd: r.gapEnd || 0 }));
            }
        } catch { /* no suggestions */ }
    }
    // One point per line, so changes are easy to read in git. Empty routes are left out.
    const routesJson = () => '{\n' + MODES.map(m => {
        const list = routes[m].filter(r => r.length);
        return ` "${m}": [` + list.map(r => '\n  [' + r.map(p => `\n   [${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}]`).join(',') + '\n  ]').join(',') +
            (list.length ? '\n ]' : ']');
    }).join(',\n') + '\n}\n';

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
            // Give the map a view straight away: Leaflet can't add lines to a map that has none yet.
            map.fitBounds(L.latLngBounds([here.pos, there.pos]), { padding: [24, 24] });
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
            if (editing) pins.forEach((p, i) => p.on('click', () => change(() => edited().push(L.latLng((i ? there : here).pos)))));

            otherLayer = L.layerGroup().addTo(map);
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
        renderRouteList();
        if (!map) return;
        const L = window.L;
        otherLayer.clearLayers();
        const faint = (pts, kind, onClick) => {
            // (In the editor the other drawn routes are amber, to stand out on satellite imagery.)
            const l = L.polyline(pts, {
                color: kind === 'osm' ? '#3d6fb5' : editing ? '#f2a900' : '#5c7366', weight: 4, opacity: editing ? 0.85 : 0.55, lineJoin: 'round',
                dashArray: kind === 'osm' ? '8 7' : null, interactive: !!onClick, bubblingMouseEvents: false,
            }).addTo(otherLayer);
            if (onClick) l.on('click', onClick).bindTooltip('Tap to use this route', { sticky: true });
        };
        let shown;
        if (editing) {
            shown = edited();
            routes[mode].forEach((r, i) => i !== cur && r.length > 1 && faint(r, 'drawn'));
            osm[mode].forEach(r => faint(r.pts, 'osm'));
            drawPoints();
        } else {
            const opts = options(), sel = nav?.option || selected(opts);
            for (const o of opts) if (o !== sel && o.id !== sel?.id) faint(o.pts, o.kind, () => pick(o.id));
            shown = sel ? sel.pts : [];
            line.setStyle({ dashArray: sel?.kind === 'osm' ? '10 6' : null });
        }
        line.setLatLngs(shown);
        if (shown.length > 1 || (!editing && options().length)) straight.remove(); else straight.addTo(map);
        if (fit) fitRoute();
    }
    const fitRoute = () => {
        const all = [here.pos, there.pos, ...routes[mode].flat(), ...osm[mode].flatMap(r => r.pts)];
        map.fitBounds(window.L.latLngBounds(all), { padding: [24, 24] });
    };

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
        const opts = options(), sel = selected(opts);
        if (!sel) { showStatus('No route has been drawn yet; the dashed line shows the direction only.'); return; }
        const others = opts.length - 1;
        showStatus(`Follow the green line from the ${lower(here)} (green pin) to the ${lower(there)} (red pin): ` +
            `<strong>${fmtDist(sel.len)}</strong>, ${fmtMin(sel.len)}.` +
            (others ? ` ${others === 1 ? 'Another route is' : `${others} other routes are`} shown in grey — tap one to use it.` : ''));
    });

    /* ---------- "From my location": live directions along the best route, using the device's GPS ---------- */
    const ARRIVED_M = 30;          // this close to the destination = arrived
    const OFF_ROUTE_M = 40;        // further than this from the line = show the way back to it
    const ROUGH_ACCURACY_M = 100;  // worse than this: warn that the location is approximate
    const SWITCH_GAIN_M = 60;      // only switch to another route mid-way if it saves at least this much
    const HOW_TO_ENABLE =
        'Turn on <strong>Location</strong> (GPS) on your phone, then allow location for this site: tap the icon ' +
        'next to the web address, choose <strong>Permissions → Location → Allow</strong>, and try again. ' +
        'On iPhone, also check <strong>Settings → Privacy → Location Services</strong> for your browser ' +
        '(with <strong>Precise Location</strong> on).';

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
        draw();
        showStatus(message || '');
    }

    function onPosition(pos) {
        nav.lastPos = pos;
        const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const acc = Math.round(pos.coords.accuracy);

        // Which routes to consider: the one tapped, else the checked (drawn) routes, else the suggestions.
        let opts = options();
        if (nav.only) opts = opts.filter(o => o.id === nav.only);
        else if (opts.some(o => o.kind === 'drawn')) opts = opts.filter(o => o.kind === 'drawn');
        if (!opts.length) opts = [{ id: 'straight', kind: 'straight', name: 'Straight line', pts: [here.pos, there.pos], len: lengthM([here.pos, there.pos]) }];

        // For each: the way from here = back to the line (if off it) + the rest of the route.
        // `toGo` is the honest distance shown; `cost` (used to choose) counts the stretch back to a
        // line three times over, because there may be no path across — so someone already on a route
        // stays on it rather than being sent cross-country to another one.
        const scored = opts.map(o => {
            const s = snap(o.pts, me, nav.progress[o.id] || 0);
            const toGoRoute = Math.max(0, o.len - s.along);
            const back = s.off > OFF_ROUTE_M ? s.off : 0;
            return { o, s, toGoRoute, toGo: toGoRoute + back, cost: toGoRoute + back * 3 };
        });
        const best = scored.reduce((a, b) => (b.cost < a.cost ? b : a));
        let use = scored.find(x => x.o.id === nav.option?.id) || best;
        let switched = false;
        if (use !== best && best.cost < use.cost - SWITCH_GAIN_M) { use = best; switched = true; }
        if (!nav.option || nav.option.id !== use.o.id) { nav.option = use.o; draw(); }
        const { o, s, toGoRoute, toGo } = use;
        nav.progress[o.id] = Math.max(nav.progress[o.id] || 0, s.along);
        const atDest = distanceKm(me, there.pos) * 1000;

        // Route split at the person's spot: done (grey) and still to go (green); dashed blue back to the line.
        const [dot, ring, done, left, back] = nav.layers;
        dot.setLatLng(me);
        ring.setLatLng(me).setRadius(pos.coords.accuracy);
        done.setLatLngs([...o.pts.slice(0, s.seg), s.at]);
        left.setLatLngs([s.at, ...o.pts.slice(s.seg)]);
        left.setStyle({ dashArray: o.kind === 'osm' ? '10 6' : null });
        back.setLatLngs(s.off > 10 ? [me, s.at] : []);

        if (nav.firstFix) {
            nav.firstFix = false;
            map.fitBounds(window.L.latLngBounds([me, s.at, there.pos]), { padding: [36, 36], maxZoom: 18 });
        } else if (nav.follow) {
            map.panTo(me, { animate: true });
        }

        if (atDest <= ARRIVED_M || (toGoRoute <= ARRIVED_M && s.off <= OFF_ROUTE_M)) {
            stopNav(`<strong>You’ve arrived</strong> at the ${lower(there)}.`);
            return;
        }
        const parts = [`<strong>${fmtDist(toGo)}</strong> to the ${lower(there)} · ${fmtMin(toGo)}`];
        if (opts.length > 1 || nav.only) parts.push(`Following <strong>${esc(o.name)}</strong>${!nav.only && o === best.o ? ' (shortest from here)' : ''}.`);
        if (switched) parts.push('Switched route: this one is shorter from where you are now.');
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
            progress: {}, follow: true, firstFix: true, wakeLock: null, option: null, only: picked, lastPos: null,
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
    const edited = () => routes[mode][cur];

    function change(fn) {
        undo.push(JSON.stringify({ routes, cur }));
        if (undo.length > 200) undo.shift();
        fn();
        draw();
    }
    function restore(snapshot) {
        const s = JSON.parse(snapshot);
        routes = s.routes;
        cur = Math.min(s.cur, routes[mode].length - 1);
        draw();
    }

    function drawPoints() {
        const L = window.L;
        pointLayer.clearLayers();
        const pts = edited();
        pts.forEach((p, i) => {
            const last = i === pts.length - 1;
            const m = L.marker(p, {
                draggable: true, keyboard: false,
                icon: L.divIcon({ className: `campus2-vertex${i === 0 ? ' first' : ''}${last ? ' last' : ''}`, iconSize: [14, 14] }),
            }).addTo(pointLayer);
            m.bindTooltip(i === 0 ? 'Start (main campus end)' : last ? 'End (Agri Lab end)' : `Point ${i + 1} — drag to move, click to delete`,
                { direction: 'top', offset: [0, -8] });
            let before = null;
            m.on('dragstart', () => (before = JSON.stringify({ routes, cur })));
            m.on('drag', e => {
                pts[i] = e.target.getLatLng();
                line.setLatLngs(pts);
            });
            m.on('dragend', e => {
                undo.push(before);
                pts[i] = e.target.getLatLng();
                draw();
            });
            m.on('click', () => change(() => pts.splice(i, 1)));
        });
    }

    // Index of the segment of the line nearest to a point (for inserting a point by clicking on the line).
    function nearestSegment(latlng) {
        const pts = edited().map(p => map.latLngToLayerPoint(p));
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
            <div class="campus2-tabs" role="group" aria-label="Routes"></div>
            <p class="campus2-help"><strong>Drawing <span class="ce-route"></span> (<span class="ce-mode"></span>).</strong>
                Click along the real route, starting at the main campus (click a campus pin to start or end exactly on it).
                Click the line to add a point in between, drag a point to move it, click a point to delete it.
                Use <em>Satellite</em> to see paths that aren't on the map. Add another route with <em>+ New route</em>;
                the map marks the shortest. Blue dashes are OpenStreetMap's suggestions, for reference.</p>
            <div class="campus2-tools">
                <button type="button" class="btn ghost small" data-act="undo">Undo</button>
                <button type="button" class="btn ghost small" data-act="reverse" title="Flip the direction of the line">Reverse</button>
                <button type="button" class="btn ghost small" data-act="clear">Clear</button>
                <button type="button" class="btn ghost small" data-act="delete">Delete route</button>
                <button type="button" class="btn primary small" data-act="save">Save</button>
            </div>
            <p class="campus2-status" aria-live="polite"></p>`;
        $('campus2Map').after(editor);

        map.on('click', e => change(() => edited().push(e.latlng)));
        line.on('click', e => {
            window.L.DomEvent.stop(e);
            change(() => edited().splice(nearestSegment(e.latlng), 0, e.latlng));
        });

        editor.addEventListener('click', e => {
            const t = e.target.closest('button');
            if (!t) return;
            const act = t.dataset.act;
            if (t.dataset.route !== undefined) { cur = +t.dataset.route; draw(); return; }
            if (act === 'new') { change(() => { routes[mode].push([]); cur = routes[mode].length - 1; }); return; }
            if (act === 'undo' && undo.length) restore(undo.pop());
            if (act === 'reverse') change(() => edited().reverse());
            if (act === 'clear' && edited().length && confirm('Delete every point of this route?')) change(() => edited().splice(0));
            if (act === 'delete' && confirm(`Delete Route ${cur + 1}?`)) change(() => {
                routes[mode].splice(cur, 1);
                if (!routes[mode].length) routes[mode].push([]);
                cur = Math.max(0, cur - 1);
            });
            if (act === 'save') save();
        });
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && undo.length && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
                e.preventDefault();
                restore(undo.pop());
            }
        });
        window.addEventListener('beforeunload', e => {
            if (routesJson() !== saved) { e.preventDefault(); e.returnValue = ''; }
        });
    }

    function updateEditor() {
        if (!editor) return;
        const tabs = editor.querySelector('.campus2-tabs');
        tabs.innerHTML = routes[mode].map((r, i) =>
            `<button type="button" class="btn small ${i === cur ? 'primary' : 'ghost'}" data-route="${i}">Route ${i + 1}` +
            `${r.length > 1 ? ` · ${fmtDist(lengthM(r))}` : ''}</button>`).join('') +
            '<button type="button" class="btn ghost small" data-act="new">+ New route</button>';
        editor.querySelector('.ce-route').textContent = `Route ${cur + 1}`;
        editor.querySelector('.ce-mode').textContent = mode === 'walking' ? 'walking' : 'driving';
        editor.querySelector('[data-act="undo"]').disabled = !undo.length;
        editor.querySelector('[data-act="delete"]').disabled = routes[mode].length < 2 && !edited().length;
        const dirty = routesJson() !== saved;
        const status = editor.querySelector('.campus2-status');
        if (!status.dataset.sticky || dirty) {
            status.dataset.sticky = '';
            status.textContent = `${edited().length} points` + (dirty ? ' · unsaved changes' : '');
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

    updateMeta();
    setMode('walking');
})();
