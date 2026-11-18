import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createPathNetwork } from './path-network.js';

/* =========================================================
   CONFIG
========================================================= */

// Which campus this page shows: map.html (main campus) or map.html?site=agri (BSC Agricultural Laboratory).
const SITE = new URLSearchParams(location.search).get('site') === 'agri' ? 'agri' : 'main';

const AGRI_FLOORS = [
    {
        id: 1, short: 'GF', name: 'Ground floor',
        url: 'models/agri_lab.fbx',
        top: null,                    // the whole file
        site: null,
        // Walkable ground around the building (surface → COST key) and the outdoor places to list.
        siteSurfaces: { Ground: 'ground', Open_Area_080113: 'landscape' },
        sitePlaces: ['Open_Area_080113'],
        // Rooms are the "Floor_<room no.>" pieces in this group ("Floor_080102_A" + "_B" = one room);
        // the others ("Floor_080101_Corridor", "Floor_Passage") are corridors.
        roomFloorGroup: 'Room_Floors',
        walkwayGroups: [],
        stairGroup: null,
        elevation: 0,
    },
];

const MAIN_FLOORS = [
    {
        id: 1, short: 'GF', name: 'Ground floor',
        url: 'models/unang_palapag.fbx',
        top: 'Batanes_State_College_Campus',
        site: 'Site',                 // outdoor ground, roads, porch live in this floor's file
        // The west walkway runs past the stair up to the north walkway (floor plan A-1);
        // the model closes it off with the stair hall's north wall.
        openings: [[16.0, -75.9, 19.0, -75.3]],
        walkwayGroups: [],
        stairGroup: null,
        elevation: 0,
    },
    {
        id: 2, short: '2F', name: '2nd floor',
        url: 'models/2nd_floor.fbx',
        top: 'BSC_Second_Floor',
        site: null,
        walkwayGroups: ['Circulation'],
        stairGroup: 'Stairs',
        elevation: 3,
        // The 2nd-floor file was modelled in its own coordinates (turned 90°).
        // This lines it up on top of the ground floor (found by matching the wall layouts).
        transform: { rotationY: 90, position: [67.52, 3.0, -11.65] },
    },
    {
        id: 3, short: '3F', name: '3rd floor',
        url: 'models/3rd_floor_final.fbx',
        top: 'BSC_Third_Floor',
        site: null,
        walkwayGroups: [],
        // Individual corridors (their parent group also holds slabs, railings and signs).
        walkways: ['North_corridor', 'East_walkway', 'Admin_lobby', 'Hostel_corridor'],
        // Floor slabs: walkable, but not listed as destinations.
        slabs: ['Classroom_wing_Slab', 'Administration_block_Slab', 'Hostel_Slab', 'Amphitheater_block_Slab', 'BAC_block_Slab'],
        stairGroup: 'Stairs_and_Services',
        stairMatch: /Stair/,          // the group also holds comfort rooms, pantry, storage
        // This file only has the top steps of each staircase. Link them to the flight
        // on the floor below that reaches the same spot ("3F stair": "2F stair").
        stairsDown: { West_Stair: 'Stair_NW', Stair_BAC: 'Stair_Procurement', Stair_Admin: 'Stair_Admin', Stair_Hostel: 'Stair_SE' },
        // The amphitheater seating is already modelled in the 2nd-floor file; drop the copy.
        remove: ['Tiers', 'Seats', 'Floor_Below_Opening', 'Floor_Below_Opening1'],
        // Doorways missing in the model, as [x0, z0, x1, z1] in the file's own coordinates:
        // the hostel lobby's east wall runs straight across the end of the hostel corridor, and
        // the BAC Meeting Room's doorway (its door is still there) is filled in with wall.
        openings: [[16.6, 25.6, 17.0, 27.5], [32.9, -31.4, 33.9, -31.0]],
        elevation: 6.4,
        // Same footprint as the 2nd-floor file, centred on the origin, floor at y = 7.
        // = 2F transform applied after shifting by (42.3, -3.6, -32.8) (found by matching the wall layouts).
        transform: { rotationY: 90, position: [34.72, -0.6, -53.95] },
    },
];

const FLOORS = SITE === 'agri' ? AGRI_FLOORS : MAIN_FLOORS;

const WALK_SPEED_MPS = 1.2;    // average walking speed
const CELL = 0.2;              // navigation grid resolution (metres)
const PATH_LIFT = 0.3;         // route line height above the floor (metres)
const DOOR_CLEARANCE = 1.8;    // wall pieces starting higher than this above the floor (door headers) don't block
const STAIR_COST_FACTOR = 1;   // 1 = stairs count by their real length (shortest distance)
const GAP_BRIDGE = 2;          // upper floors: bridge modelling gaps up to 2×this (metres) between floors/corridors

// Movement cost per metre. 1 = plain walking distance, so routes are the shortest walk.
// Only places you shouldn't walk through get a penalty.
const COST = {
    endpoint: 1,      // inside the start / destination room
    walkway: 1,       // corridors, porch
    lobby: 1,         // lobbies, open halls, stair halls
    ground: 1,        // campus ground
    smallStair: 1,    // short flights within a floor
    landscape: 1,     // lawns / open space
    none: 1,          // unmodelled ground / small modelling gaps
    road: 1.5,        // streets: only used when clearly shorter
    room: 10,         // cutting through somebody else's room (last resort)
};
const LOS_MAX = 1 + 1e-6;      // straight-line shortcuts only across plain walking surfaces

const SITE_SURFACES = {
    Ground_Lot: 'ground',
    Open_Space_Landscape: 'landscape',
    National_Road: 'road',
    Minor_Road: 'road',
    Porch: 'walkway',
};
const SITE_PLACES = ['Porch', 'Open_Space_Landscape', 'National_Road', 'Minor_Road'];
const isLobbyLike = k => /(Lobby|Hall_Open|Corridor|Hallway|Stair|Landing)/i.test(k);
const FURNITURE_RE = /^(Chair|Counter|Mesh|Leg|Seat|Back|Body|Desk|Table|Stool|Wall|Door|Window|Furniture)/;
const NOT_A_PLACE_RE = /^(Columns?|Fixtures)\d*$|open_to_below/i;   // structure / holes, not destinations

const NAME_OVERRIDES = {
    Open_Space_Landscape: 'Open Space',
    Hall_Open_Below: 'Hall',
    CR_HE: 'Comfort Room (HE)',
    CR_SHE: 'Comfort Room (SHE)',
    FBS: 'FBS Room',
    FBS_Annex: 'FBS Annex',
    NW_Corridor_Link: 'NW Corridor Link',
    Open_Area_080113: 'Open Area',
};

function prettyName(key) {
    if (NAME_OVERRIDES[key]) return NAME_OVERRIDES[key];
    // drop SketchUp's duplicate suffix ("Classroom_Rm123_1") but keep real numbers ("Classroom_211")
    let s = key.replace(/(\D|Rm\d+)_\d$/, '$1').replace(/_/g, ' ');
    s = s.replace(/^(.*?) ?Rm ?(\d+)$/, (_, a, n) => (a ? `${a} (Rm ${n})` : `Room ${n}`));
    s = s.replace(/\bIGP\b/, '(IGP)').replace(/\bNE\b/, '(NE)');
    return s;
}

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =========================================================
   DOM
========================================================= */

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const fromSelect = $('fromSelect');
const toSelect = $('toSelect');
const routeResult = $('routeResult');
const routeError = $('routeError');
const stepsEl = $('steps');
const placeList = $('placeList');
const searchInput = $('searchInput');
const infoCard = $('infoCard');
const loaderText = $('loaderText');
const floorSwitch = $('floorSwitch');

/* =========================================================
   SCENE
========================================================= */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
viewport.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8efe9);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 3000);
camera.position.set(0, 80, 80);

const controls = new OrbitControls(camera, labelRenderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.46;
controls.minDistance = 5;
controls.maxDistance = 400;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8aa07a, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

function resize() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

/* =========================================================
   STATE
========================================================= */

const floors = FLOORS.map(cfg => ({
    ...cfg, root: null, grid: null, merged: null, offset: 0,
    pickables: [], wallMaterials: [], labels: [], stairs: [],
}));
const floorById = id => floors.find(f => f.id === id);
const places = new Map();          // key ("<floor>:<name>") -> place
const placeList_ = [];             // index -> place (global, used by the nav grids)
const portals = new Map();         // nav node -> [{ to, cost, stair }]
let totalNodes = 0;
let campusBox = null;
let route = null;
let selectedKey = null;
let activeFloor = 1;
let xray = false;
let tween = null;
let pathNet = null;                // hand-drawn walking paths (paths.json); used for routing when present

/* =========================================================
   MODEL LOADING
========================================================= */

const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

// The models are shipped gzip-compressed next to the originals (models/*.fbx.gz, about 20× smaller;
// made by tools/compress-models.mjs) and unpacked here. Falls back to the plain .fbx when there's
// no compressed copy or the browser can't unpack it.
async function loadFBX(floor, progress) {
    const fetchBuffer = url => new Promise((resolve, reject) => {
        const loader = new THREE.FileLoader();
        loader.setResponseType('arraybuffer');
        loader.load(url, resolve, xhr => progress(floor, xhr), reject);
    });
    // map.html starts these downloads before the scripts have loaded (window.modelDownloads).
    const early = window.modelDownloads?.[`${floor.url}.gz`];
    const fetchEarly = async () => {
        const tick = setInterval(() => progress(floor, early), 100);
        try { return await early.promise; } finally { clearInterval(tick); progress(floor, early); }
    };
    let buffer = null;
    if (typeof DecompressionStream !== 'undefined') {
        try {
            buffer = early ? await fetchEarly() : await fetchBuffer(`${floor.url}.gz`);
            const head = new Uint8Array(buffer, 0, 2);
            if (head[0] === 0x1f && head[1] === 0x8b) {   // still gzip (the server didn't unpack it on the way)
                const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
                buffer = await new Response(stream).arrayBuffer();
            }
        } catch {
            console.warn(`[map] no compressed copy of ${floor.url}, loading the full file`);
            buffer = null;
        }
    }
    if (!buffer) buffer = await fetchBuffer(floor.url);
    return new FBXLoader().parse(buffer, floor.url.replace(/[^/]*$/, ''));
}

(async function init() {
    if (location.protocol === 'file:') return;
    const prog = new Map();
    const onProgress = (floor, xhr) => {
        prog.set(floor.id, xhr);
        let loaded = 0, total = 0;
        prog.forEach(x => { loaded += x.loaded; total += x.total || 0; });
        if (total) loaderText.textContent = `Loading 3D campus… ${Math.round(loaded / total * 100)}%`;
    };
    let roots;
    try {
        roots = await Promise.all(floors.map(f => loadFBX(f, onProgress)));
    } catch (err) {
        console.error(err);
        loaderText.innerHTML = `Couldn't load the 3D models in <code>models/</code>. Make sure you're running <code>node server.js</code>.`;
        document.querySelector('#loader .spinner').hidden = true;
        return;
    }
    try {
        loaderText.textContent = 'Preparing campus map…';
        await nextFrame();
        floors.forEach((f, i) => {
            f.root = roots[i];
            if (f.remove) {
                const drop = [];
                f.root.traverse(o => f.remove.includes(o.name) && drop.push(o));
                drop.forEach(o => o.parent.remove(o));
            }
            normaliseUnits(f.root);
            if (f.transform) {
                f.root.rotation.y = THREE.MathUtils.degToRad(f.transform.rotationY || 0);
                f.root.position.fromArray(f.transform.position || [0, 0, 0]);
            }
            scene.add(f.root);
            f.root.updateMatrixWorld(true);
            buildPlaces(f);
        });
        placeList_.push(...places.values());
        placeList_.forEach((p, i) => (p.index = i));
        createLabels();

        loaderText.textContent = 'Building walking routes…';
        await nextFrame();
        for (const f of floors) {
            buildGrid(f);
            f.offset = totalNodes;
            totalNodes += f.grid.nx * f.grid.nz;
        }
        buildPortals();
        pathNet = createPathNetwork({
            site: SITE, scene, camera, controls, dom: labelRenderer.domElement, floors, places, floorById,
            activeFloor: () => activeFloor, setActiveFloor, heightAt, distToBox2, onChange: () => {},
        });
        await pathNet.load();
        loaderText.textContent = 'Optimising 3D view…';
        await nextFrame();
        floors.forEach(optimiseMeshes);
        setupLightsAndCamera();
        buildUI();
        setActiveFloor(1);
        // Compile the shaders before the first frame (in the background where the browser supports it).
        try { await renderer.compileAsync(scene, camera); } catch { /* the first frame compiles them instead */ }
        sceneReady = true;
        $('loader').classList.add('done');
        window.dispatchEvent(new Event('campusmap:ready'));
        applyUrlParams();
        if (new URLSearchParams(location.search).has('edit')) pathNet.startEditing();
    } catch (err) {
        console.error(err);
        loaderText.textContent = `Something went wrong preparing the map: ${err.message}`;
        document.querySelector('#loader .spinner').hidden = true;
    }
})();

const isWallName = n => /^(Wall_|Rail_|Railing|Column_)/.test(n);
const isDoorName = n => /^Door_/.test(n);
const isFloorName = n => /^Floor\d*$/.test(n);

// In these FBX files every part ("Floor13", "Wall_N4", "Door_W_1") is a group holding the actual mesh(es).
function partKind(mesh, stopAt) {
    for (let n = mesh; n && n !== stopAt; n = n.parent) {
        if (isWallName(n.name)) return /Head/.test(n.name) ? 'header' : 'wall';
        if (isDoorName(n.name)) return 'door';
        if (isFloorName(n.name)) return 'floor';
    }
    return null;
}
const hasFloorChild = g => g.children.some(c => isFloorName(c.name));
function floorMeshesOf(g) {
    const out = [];
    for (const c of g.children) if (isFloorName(c.name)) c.traverse(m => m.isMesh && out.push(m));
    return out;
}
const meshesOf = g => { const out = []; g.traverse(m => m.isMesh && out.push(m)); return out; };

// Work out the model's units (SketchUp exports can be m, cm, mm, inches or feet)
// from the typical wall height, and scale the model to metres.
function normaliseUnits(root) {
    root.updateMatrixWorld(true);
    const heights = [];
    root.traverse(o => {
        if (o.isMesh && partKind(o, root) === 'wall') {
            const b = new THREE.Box3().setFromObject(o);
            heights.push(b.max.y - b.min.y);
        }
    });
    heights.sort((a, b) => a - b);
    const typical = heights.length ? heights[Math.floor(heights.length / 2)] : 3;
    const units = [1, 100, 1000, 39.3701, 3.28084];  // units per metre
    const perMetre = units.reduce((best, u) =>
        Math.abs(Math.log(typical / u / 3)) < Math.abs(Math.log(typical / best / 3)) ? u : best, 1);
    root.scale.setScalar(1 / perMetre);
    root.updateMatrixWorld(true);
}

/* ---------- Rooms & places ---------- */

function buildPlaces(floor) {
    const root = floor.root;
    const top = root.getObjectByName(floor.top) || root;
    floor.topObj = top;
    const site = floor.site ? top.getObjectByName(floor.site) : null;
    const sg = floor.stairGroup && top.getObjectByName(floor.stairGroup);
    const stairParts = sg ? sg.children.filter(c => !floor.stairMatch || floor.stairMatch.test(c.name)) : [];
    const walkways = (floor.walkways || []).map(n => top.getObjectByName(n)).filter(Boolean);
    const skip = new Set([site, ...floor.walkwayGroups.map(n => top.getObjectByName(n)), ...walkways,
        ...(floor.stairMatch ? stairParts : [sg])].filter(Boolean));

    const addPlace = (raw, group, category, kind, floorParts = null) => {
        const floorsM = floorParts ? floorParts.flatMap(meshesOf) : kind === 'room' ? floorMeshesOf(group) : [];
        const box = new THREE.Box3();
        (floorsM.length ? floorsM : [group]).forEach(o => box.expandByObject(o));
        if (box.isEmpty()) return null;
        const key = `${floor.id}:${raw}`;
        const p = {
            key, raw, group, category, kind, floor, box,
            floors: floorsM,
            name: prettyName(raw),
            center: new THREE.Vector2((box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2),
            floorY: floorsM.length ? box.max.y : Math.max(floor.elevation, box.min.y),
            isRoom: kind === 'room' || kind === 'partial',
        };
        p.travelCost = isLobbyLike(raw) ? COST.lobby : COST.room;
        places.set(key, p);
        const pick = floorsM.length ? floorsM : meshesOf(group);
        pick.forEach(m => { m.userData.placeKey = key; floor.pickables.push(m); });
        return p;
    };

    // Rooms: any group with a Floor part as a direct child. Category = the wing it's in.
    const wings = new Set();
    top.traverse(g => {
        if (g.isMesh || isFloorName(g.name) || !hasFloorChild(g)) return;
        for (let a = g; a && a !== top; a = a.parent) if (skip.has(a)) return;
        let wing = g.parent;   // the wing = nearest ancestor directly under the top group (or under "Rooms")
        while (wing !== top && wing.parent && wing.parent !== top && wing.parent.name !== "Rooms") wing = wing.parent;
        const category = wing === top ? prettyName(g.name) : prettyName(wing.name);
        if (addPlace(g.name, g, category, 'room') && wing !== top) wings.add(wing);
    });
    // Partly-modelled rooms (no floor in the model) — still offer them as destinations.
    for (const wing of wings) {
        if (hasFloorChild(wing)) continue;   // a room inside a room (e.g. a control room) — not a wing
        for (const g of wing.children) {
            if (g.isMesh || !g.children.length || hasFloorChild(g) || skip.has(g) ||
                FURNITURE_RE.test(g.name) || NOT_A_PLACE_RE.test(g.name)) continue;
            addPlace(g.name, g, prettyName(wing.name), 'partial');
        }
    }
    // Corridors / walkways
    for (const name of floor.walkwayGroups) {
        const g = top.getObjectByName(name);
        if (g) for (const c of g.children) if (!isWallName(c.name)) addPlace(c.name, c, "Corridors & Lobbies", "walkway");
    }
    for (const g of walkways) addPlace(g.name, g, "Corridors & Lobbies", "walkway");
    // Rooms given as numbered floor pieces ("Floor_080111" → Room 080111)
    const rf = floor.roomFloorGroup && top.getObjectByName(floor.roomFloorGroup);
    if (rf) {
        const rooms = new Map();
        for (const c of rf.children) {
            const m = /^Floor_(\d+)(?:_[A-Za-z])?$/.exec(c.name);
            if (m) {
                const raw = `Room_${m[1]}`;
                if (!rooms.has(raw)) rooms.set(raw, []);
                rooms.get(raw).push(c);
            } else {
                const w = /^Floor_(?:\d+_)?(.+)$/.exec(c.name);
                if (w) addPlace(w[1], c, 'Corridors & Lobbies', 'walkway');
            }
        }
        for (const [raw, parts] of rooms) addPlace(raw, parts[0], 'Rooms', 'room', parts);
    }
    // Stairs
    for (const c of stairParts) {
        const p = addPlace(c.name, c, 'Stairs', 'stair');
        if (p) floor.stairs.push(p);
    }
    // Outdoor places
    const outdoor = site || (floor.siteSurfaces ? top : null);
    if (outdoor) for (const raw of floor.sitePlaces || SITE_PLACES) {
        const g = outdoor.getObjectByName(raw);
        if (g) addPlace(raw, g, 'Outside', 'outside');
    }

    // Unique display names within the floor
    const seen = new Map();
    for (const p of places.values()) {
        if (p.floor !== floor) continue;
        const n = seen.get(p.name) || 0;
        seen.set(p.name, n + 1);
        if (n) p.name = `${p.name} · ${p.category}`;
    }

    // Wing labels
    const byCat = new Map();
    for (const p of places.values()) {
        if (p.floor !== floor || !p.isRoom) continue;
        if (!byCat.has(p.category)) byCat.set(p.category, new THREE.Box3());
        byCat.get(p.category).union(p.box);
    }
    floor.wingLabels = [...byCat].map(([name, b]) => ({ name, pos: b.getCenter(new THREE.Vector3()).setY(b.max.y + 6) }));
    console.info(`[map] ${floor.name}: ${[...places.values()].filter(p => p.floor === floor).length} places`);
}

function createLabels() {
    for (const p of places.values()) {
        const div = document.createElement('div');
        div.className = 'map-label' + (p.kind === 'outside' ? ' outside' : '') +
            (p.kind === 'walkway' || p.kind === 'stair' || isLobbyLike(p.raw) ? ' walkway' : '');
        div.textContent = p.name;
        const label = new CSS2DObject(div);
        label.position.set(p.center.x, p.floorY + (p.isRoom ? 3.4 : 0.8), p.center.y);
        scene.add(label);
        p.label = div;
        p.labelObj = label;
        p.floor.labels.push(label);
    }
    for (const f of floors) {
        for (const w of f.wingLabels) {
            const div = document.createElement('div');
            div.className = 'map-label wing';
            div.textContent = w.name;
            const label = new CSS2DObject(div);
            label.position.copy(w.pos);
            scene.add(label);
            f.labels.push(label);
        }
    }
    campusBox = new THREE.Box3();
    for (const p of places.values()) if (p.isRoom) campusBox.union(p.box);
}

/* =========================================================
   NAVIGATION GRIDS (one per floor) + STAIR PORTALS
========================================================= */

function forEachTriangle(mesh, fn) {
    const pos = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
        const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
        fn(a, b, c);
    }
}

function buildGrid(floor) {
    const root = floor.root;
    // siteGroup: the floor's outdoor ground (everything not modelled counts as walkable ground)
    const siteGroup = floor.site ? floor.topObj.getObjectByName(floor.site) : floor.siteSurfaces ? floor.topObj : null;
    const bounds = new THREE.Box3().setFromObject(siteGroup || root).expandByScalar(siteGroup ? 0 : 1);
    const ox = bounds.min.x, oz = bounds.min.z;
    const nx = Math.ceil((bounds.max.x - ox) / CELL) + 1;
    const nz = Math.ceil((bounds.max.z - oz) / CELL) + 1;
    const N = nx * nz;
    // Upper floors: only modelled floors/corridors can be walked on (elsewhere is open air).
    const surf = new Float32Array(N).fill(siteGroup ? COST.none : Infinity);
    const owner = new Int16Array(N).fill(-1);
    const blocked = new Uint8Array(N);
    const height = new Float32Array(N).fill(floor.elevation);

    const fillTop = (a, b, c, fn) => {
        const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - a.x, vz = c.z - a.z;
        const area2 = ux * vz - uz * vx;
        if (Math.abs(area2) < 1e-6) return;
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
        if (Math.abs(n.y) < 0.7) return;  // only roughly horizontal surfaces
        const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - ox) / CELL));
        const x1 = Math.min(nx - 1, Math.floor((Math.max(a.x, b.x, c.x) - ox) / CELL));
        const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - oz) / CELL));
        const z1 = Math.min(nz - 1, Math.floor((Math.max(a.z, b.z, c.z) - oz) / CELL));
        for (let z = z0; z <= z1; z++) {
            const pz = oz + (z + 0.5) * CELL - a.z;
            for (let x = x0; x <= x1; x++) {
                const px = ox + (x + 0.5) * CELL - a.x;
                const s = (px * vz - pz * vx) / area2;
                const t = (ux * pz - uz * px) / area2;
                if (s < -1e-4 || t < -1e-4 || s + t > 1 + 1e-4) continue;
                fn(z * nx + x, a.y + s * (b.y - a.y) + t * (c.y - a.y));
            }
        }
    };
    const fillBox = (box, fn) => {
        const x0 = Math.max(0, Math.floor((box.min.x - ox) / CELL)), x1 = Math.min(nx - 1, Math.floor((box.max.x - ox) / CELL));
        const z0 = Math.max(0, Math.floor((box.min.z - oz) / CELL)), z1 = Math.min(nz - 1, Math.floor((box.max.z - oz) / CELL));
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) fn(z * nx + x);
    };
    const fillSampled = (mesh, maxY, fn) => {
        const step = CELL * 0.5, p = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
        forEachTriangle(mesh, (a, b, c) => {
            const n = Math.ceil(Math.max(a.distanceTo(b), a.distanceTo(c), b.distanceTo(c)) / step);
            ab.subVectors(b, a); ac.subVectors(c, a);
            for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
                p.copy(a).addScaledVector(ab, i / n).addScaledVector(ac, j / n);
                if (p.y > maxY) continue;
                const x = Math.floor((p.x - ox) / CELL), z = Math.floor((p.z - oz) / CELL);
                if (x >= 0 && z >= 0 && x < nx && z < nz) fn(z * nx + x);
            }
        });
    };
    const rasterise = (group, fn) => meshesOf(group).forEach(m => forEachTriangle(m, (a, b, c) => fillTop(a, b, c, fn)));

    // 1. outdoor surfaces
    if (siteGroup) {
        for (const [raw, surface] of Object.entries(floor.siteSurfaces || SITE_SURFACES)) {
            const g = siteGroup.getObjectByName(raw);
            if (!g) continue;
            const cost = COST[surface];
            const p = places.get(`${floor.id}:${raw}`);
            rasterise(g, (i, y) => { surf[i] = cost; height[i] = y; owner[i] = p ? p.index : -1; });
        }
    }
    // 1b. floor slabs (upper floors modelled as whole-block slabs)
    for (const name of floor.slabs || []) {
        const g = floor.topObj.getObjectByName(name);
        if (g) rasterise(g, (i, y) => { surf[i] = COST.walkway; height[i] = Math.max(height[i], y); });
    }
    // 2. corridors and short flights of steps
    for (const p of placeList_) {
        if (p.floor !== floor) continue;
        if (p.kind === 'walkway') rasterise(p.group, (i, y) => { surf[i] = COST.walkway; height[i] = y; owner[i] = p.index; });
        if (p.kind === 'stair' && p.box.max.y - p.box.min.y < 2) {
            rasterise(p.group, (i, y) => { if (y >= height[i] - 0.05 || surf[i] === Infinity) { surf[i] = COST.smallStair; height[i] = y; } });
        }
    }
    // 3. room floors
    for (const p of placeList_) {
        if (p.floor !== floor) continue;
        for (const f of p.floors) {
            forEachTriangle(f, (a, b, c) => fillTop(a, b, c, (i, y) => {
                if (y < height[i] - 0.05 && owner[i] >= 0 && placeList_[owner[i]].isRoom) return;
                owner[i] = p.index; height[i] = y;
                if (surf[i] === Infinity) surf[i] = COST.room;
            }));
        }
    }
    // 4. walls block, doors open them again (door headers above the opening are ignored)
    const walls = [], doors = [], headers = [];
    root.traverse(o => {
        if (!o.isMesh) return;
        const kind = partKind(o, root);
        if (kind === 'wall') walls.push(o);
        if (kind === 'door') doors.push(o);
        if (kind === 'header') headers.push(o);
    });
    const floorAt = box => {
        const cx = Math.floor(((box.min.x + box.max.x) / 2 - ox) / CELL), cz = Math.floor(((box.min.z + box.max.z) / 2 - oz) / CELL);
        return height[Math.min(nz - 1, Math.max(0, cz)) * nx + Math.min(nx - 1, Math.max(0, cx))];
    };
    // Openings to the floor below (light wells, stage voids) can't be walked on.
    const hole = new Uint8Array(N);
    floor.topObj.traverse(g => {
        if (!/open_to_below/i.test(g.name)) return;
        fillBox(new THREE.Box3().setFromObject(g), i => { surf[i] = Infinity; owner[i] = -1; hole[i] = 1; });
    });
    const doorBoxes = doors.map(d => new THREE.Box3().setFromObject(d).expandByScalar(0.05));
    const wallBoxes = [];
    for (const w of walls) {
        const box = new THREE.Box3().setFromObject(w);
        if (box.max.y - box.min.y < 0.05) continue;   // flat leftover piece, not a real wall
        wallBoxes.push(box);
        const base = Math.min(floorAt(box), box.min.y);
        if (box.min.y > base + DOOR_CLEARANCE) {
            // a header that isn't named "Head" (e.g. 3rd floor): wall piece above head height touching a door leaf
            if (doorBoxes.some(d => d.intersectsBox(box))) headers.push(w);
            continue;
        }
        const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
        if (Math.min(sx, sz) < 0.6) fillBox(box, i => (blocked[i] = 1));
        else fillSampled(w, base + DOOR_CLEARANCE, i => (blocked[i] = 1));
    }
    for (const d of doors) fillBox(new THREE.Box3().setFromObject(d), i => (blocked[i] = 0));
    // A header ("Wall_S_Head7") always sits over a doorway. Open the doorway, including any wall
    // modelled right against it on the other side (e.g. a neighbouring room's wall without a gap).
    for (const hd of headers) {
        const b = new THREE.Box3().setFromObject(hd);
        const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
        if (Math.max(sx, sz) > 3 || Math.min(sx, sz) > 0.6) continue;   // not a door-sized opening
        // a wall piece (sill) right under the header: it's the top of a window, not a doorway
        const overlap = w => Math.min(w.max.x, b.max.x) - Math.max(w.min.x, b.min.x) > -0.01 &&
            Math.min(w.max.z, b.max.z) - Math.max(w.min.z, b.min.z) > -0.01 &&
            Math.max(Math.min(w.max.x, b.max.x) - Math.max(w.min.x, b.min.x), Math.min(w.max.z, b.max.z) - Math.max(w.min.z, b.min.z)) > 0.5 * Math.max(sx, sz);
        if (wallBoxes.some(w => w.max.y < b.min.y - 0.05 && overlap(w))) continue;
        const open = b.clone();
        if (sx < sz) { open.min.x -= 0.35; open.max.x += 0.35; open.min.z += 0.05; open.max.z -= 0.05; }
        else { open.min.z -= 0.35; open.max.z += 0.35; open.min.x += 0.05; open.max.x -= 0.05; }
        fillBox(open, i => (blocked[i] = 0));
    }
    for (const [x0, z0, x1, z1] of floor.openings || []) {
        const b = new THREE.Box3();
        for (const [x, z] of [[x0, z0], [x1, z1]]) b.expandByPoint(new THREE.Vector3(x, 0, z).applyMatrix4(root.matrixWorld));
        fillBox(b, i => (blocked[i] = 0));
    }

    // Remember where each room's doors are (used for landmarks in the directions).
    const placeOfGroup = new Map(placeList_.filter(p => p.floor === floor).map(p => [p.group, p]));
    for (const d of [...doors, ...headers]) {
        let p = null;
        for (let n = d; n && !p; n = n.parent) p = placeOfGroup.get(n);
        if (!p) continue;
        const c = new THREE.Box3().setFromObject(d).getCenter(new THREE.Vector3());
        const pt = new THREE.Vector2(c.x, c.z);
        (p.doors ||= []);
        if (p.doors.every(q => q.distanceTo(pt) > 0.8)) p.doors.push(pt);
    }

    // 5. Upper floors: rooms and corridors were modelled with small gaps between them.
    //    Bridge gaps narrower than 2×GAP_BRIDGE (a morphological "closing"), never through walls.
    let bridged = 0;
    if (!siteGroup) {
        const R = GAP_BRIDGE / CELL;
        const walk = i => !blocked[i] && (surf[i] !== Infinity || owner[i] >= 0);
        const dist = (isSeed) => {   // two-pass chamfer distance (in cells) to the nearest seed cell
            const d = new Float32Array(N);
            for (let i = 0; i < N; i++) d[i] = isSeed(i) ? 0 : 1e9;
            const D = Math.SQRT2;
            for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
                const i = z * nx + x; let v = d[i];
                if (x > 0) v = Math.min(v, d[i - 1] + 1);
                if (z > 0) { v = Math.min(v, d[i - nx] + 1); if (x > 0) v = Math.min(v, d[i - nx - 1] + D); if (x < nx - 1) v = Math.min(v, d[i - nx + 1] + D); }
                d[i] = v;
            }
            for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) {
                const i = z * nx + x; let v = d[i];
                if (x < nx - 1) v = Math.min(v, d[i + 1] + 1);
                if (z < nz - 1) { v = Math.min(v, d[i + nx] + 1); if (x < nx - 1) v = Math.min(v, d[i + nx + 1] + D); if (x > 0) v = Math.min(v, d[i + nx - 1] + D); }
                d[i] = v;
            }
            return d;
        };
        // never bridge over a stairwell opening
        const stairwell = new Uint8Array(N);
        for (const p of placeList_) {
            if (p.floor !== floor || p.kind !== 'stair' || p.box.max.y - p.box.min.y < 2) continue;
            for (const step of p.group.children) {   // the lower half of the flight is a hole; the top steps meet the landing
                const b = new THREE.Box3().setFromObject(step);
                if (!b.isEmpty() && b.max.y < floor.elevation - 1.5) fillBox(b, i => (stairwell[i] = 1));
            }
        }
        const d1 = dist(walk);                                  // dilate
        const edge = i => { const x = i % nx, z = (i / nx) | 0; return x === 0 || z === 0 || x === nx - 1 || z === nz - 1; };
        const d2 = dist(i => d1[i] > R || edge(i));             // erode back (outside the grid counts as open air)
        for (let i = 0; i < N; i++) {
            if (d2[i] > R && !walk(i) && !blocked[i] && !stairwell[i] && !hole[i]) { surf[i] = COST.none; height[i] = floor.elevation; bridged++; }
        }
    }

    floor.grid = { ox, oz, nx, nz, surf, owner, blocked, height };
    console.info(`[map] ${floor.name} nav grid ${nx}×${nz}, ${walls.length} walls, ${doors.length} doors, ${bridged} gap cells bridged`);
}

function cellCost(g, i, allow) {
    if (g.blocked[i]) return Infinity;
    const o = g.owner[i];
    if (o >= 0) {
        if (allow.has(o)) return COST.endpoint;
        const p = placeList_[o];
        if (p.isRoom) return p.travelCost;
    }
    return g.surf[i];
}

function cellOf(g, v) {
    const x = Math.min(g.nx - 1, Math.max(0, Math.floor((v.x - g.ox) / CELL)));
    const z = Math.min(g.nz - 1, Math.max(0, Math.floor((v.y - g.oz) / CELL)));
    return z * g.nx + x;
}
const cellCenter = (g, i) => new THREE.Vector2(g.ox + ((i % g.nx) + 0.5) * CELL, g.oz + (Math.floor(i / g.nx) + 0.5) * CELL);
const heightAt = (floor, v) => floor.grid.height[cellOf(floor.grid, v)];
const NO_ALLOW = new Set();

function nearestPassable(g, i, allow, preferOwner = -1) {
    const ok = j => cellCost(g, j, allow) !== Infinity && (preferOwner < 0 || g.owner[j] === preferOwner);
    if (ok(i)) return i;
    const cx = i % g.nx, cz = Math.floor(i / g.nx);
    for (let r = 1; r < 100; r++) {
        let best = -1, bestD = Infinity;
        for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const x = cx + dx, z = cz + dz;
                if (x < 0 || z < 0 || x >= g.nx || z >= g.nz) continue;
                const j = z * g.nx + x, d = dx * dx + dz * dz;
                if (d < bestD && ok(j)) { best = j; bestD = d; }
            }
        }
        if (best >= 0) return best;
    }
    return preferOwner >= 0 ? nearestPassable(g, i, allow) : -1;
}

// Walkable cells around a stair end, found by searching outward without passing through walls
// (so a landing never gets attached to the room on the other side of a wall). A landing can open
// onto several corridors, so this returns a few cells spread around it, nearest first.
function landingCells(g, i, maxCells = 12) {
    const seen = new Map([[i, 0]]);
    const queue = [i], found = [];
    let firstD = -1;
    for (let q = 0; q < queue.length; q++) {
        const c = queue[q], d = seen.get(c);
        if (cellCost(g, c, NO_ALLOW) !== Infinity) {
            if (firstD < 0) firstD = d;
            const p = cellCenter(g, c);
            if (d <= firstD + maxCells && found.every(f => cellCenter(g, f).distanceTo(p) > 1.2)) found.push(c);
            if (found.length >= 6) break;
            continue;   // don't search beyond walkable cells
        }
        if (firstD >= 0 ? d > firstD + maxCells : d >= 40) continue;
        const x = c % g.nx, z = Math.floor(c / g.nx);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const X = x + dx, Z = z + dz;
            if (X < 0 || Z < 0 || X >= g.nx || Z >= g.nz) continue;
            const j = Z * g.nx + X;
            if (seen.has(j) || g.blocked[j]) continue;
            seen.set(j, d + 1);
            queue.push(j);
        }
    }
    if (found.length) return found;
    const fallback = nearestPassable(g, i, NO_ALLOW);
    return fallback >= 0 ? [fallback] : [];
}

// Connect floors through staircases that span from one floor level to the next.
function buildPortals() {
    const floorNear = y => floors.reduce((best, f) => (Math.abs(f.elevation - y) < Math.abs(best.elevation - y) ? f : best));
    for (const f of floors) {
        for (const st of f.stairs) {
            const box = st.box;
            if (box.max.y - box.min.y < 2) continue;
            const steps = st.group.children.map(c => new THREE.Box3().setFromObject(c)).filter(b => !b.isEmpty());
            if (steps.length < 2) continue;
            steps.sort((a, b) => a.max.y - b.max.y);
            const lowC = steps[0].getCenter(new THREE.Vector3()), highC = steps[steps.length - 1].getCenter(new THREE.Vector3());
            const lower = floorNear(box.min.y), upper = floorNear(box.max.y);
            if (lower === upper) continue;
            // Search from the first/last step itself (not past it: a stair that turns back on a
            // landing would put that point behind a wall).
            const lowP = new THREE.Vector2(lowC.x, lowC.z), highP = new THREE.Vector2(highC.x, highC.z);
            const bottoms = landingCells(lower.grid, cellOf(lower.grid, lowP)).slice(0, 1);
            const tops = landingCells(upper.grid, cellOf(upper.grid, highP));
            if (!bottoms.length || !tops.length) { console.warn(`[map] couldn't connect ${st.raw}`); continue; }
            const len = Math.hypot(lowP.distanceTo(highP) + 1.2, upper.elevation - lower.elevation);
            const cost = (len / CELL) * STAIR_COST_FACTOR;
            const link = (from, to) => {
                if (!portals.has(from)) portals.set(from, []);
                portals.get(from).push({ to, cost, stair: st, len });
            };
            for (const a of bottoms) for (const b of tops) {
                link(lower.offset + a, upper.offset + b);
                link(upper.offset + b, lower.offset + a);
            }
            console.info(`[map] stair ${st.raw}: ${lower.short} ↔ ${upper.short} (${tops.length} landing exit${tops.length > 1 ? 's' : ''})`);
        }
    }
    // Floors whose file only has the top of each staircase: continue the flight that reaches the
    // same spot on the floor below (config `stairsDown`).
    for (const upper of floors) {
        if (!upper.stairsDown) continue;
        const lower = floors[floors.indexOf(upper) - 1];
        for (const [upName, lowName] of Object.entries(upper.stairsDown)) {
            const upSt = places.get(`${upper.id}:${upName}`), lowSt = places.get(`${lower.id}:${lowName}`);
            if (!upSt || !lowSt) { console.warn(`[map] couldn't connect ${upName} ↔ ${lowName}`); continue; }
            const steps = lowSt.group.children.map(c => new THREE.Box3().setFromObject(c)).filter(b => !b.isEmpty());
            steps.sort((a, b) => a.max.y - b.max.y);
            const lowC = steps[0].getCenter(new THREE.Vector3()), highC = steps[steps.length - 1].getCenter(new THREE.Vector3());
            const highP = new THREE.Vector2(highC.x, highC.z);
            const bottoms = landingCells(lower.grid, cellOf(lower.grid, highP));
            const tops = landingCells(upper.grid, cellOf(upper.grid, upSt.center));
            if (!bottoms.length || !tops.length) { console.warn(`[map] couldn't connect ${upName} ↔ ${lowName}`); continue; }
            const len = Math.hypot(new THREE.Vector2(lowC.x, lowC.z).distanceTo(highP) + 1.2, upper.elevation - lower.elevation);
            const cost = (len / CELL) * STAIR_COST_FACTOR;
            const link = (from, to, stair) => {
                if (!portals.has(from)) portals.set(from, []);
                portals.get(from).push({ to, cost, stair, len });
            };
            for (const a of bottoms) for (const b of tops) {
                link(lower.offset + a, upper.offset + b, lowSt);
                link(upper.offset + b, lower.offset + a, upSt);
            }
            console.info(`[map] stair ${lowName} → ${upName}: ${lower.short} ↔ ${upper.short}`);
        }
    }
}

/* ---------- A* over all floors ---------- */

class MinHeap {
    constructor() { this.f = []; this.id = []; }
    get size() { return this.id.length; }
    push(id, f) {
        const F = this.f, I = this.id;
        let i = I.length; F.push(f); I.push(id);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (F[p] <= f) break;
            F[i] = F[p]; I[i] = I[p]; i = p;
        }
        F[i] = f; I[i] = id;
    }
    pop() {
        const F = this.f, I = this.id, top = I[0];
        const lf = F.pop(), li = I.pop();
        if (I.length) {
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = -1, mf = lf;
                if (l < I.length && F[l] < mf) { m = l; mf = F[l]; }
                if (r < I.length && F[r] < mf) { m = r; mf = F[r]; }
                if (m < 0) break;
                F[i] = F[m]; I[i] = I[m]; i = m;
            }
            F[i] = lf; I[i] = li;
        }
        return top;
    }
}

const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

function nodeFloor(n) {
    for (let k = floors.length - 1; k >= 0; k--) if (n >= floors[k].offset) return floors[k];
    return floors[0];
}

// Does the straight line between the centres of two cells cross only plain walking surface?
// (Grid traversal that visits every cell the line touches; corners count as both neighbours.)
function losCells(G, a, b, allow) {
    let x = a % G.nx, z = (a / G.nx) | 0;
    const x1 = b % G.nx, z1 = (b / G.nx) | 0;
    const dx = Math.abs(x1 - x), dz = Math.abs(z1 - z), sx = x < x1 ? 1 : -1, sz = z < z1 ? 1 : -1;
    const ok = (X, Z) => cellCost(G, Z * G.nx + X, allow) <= LOS_MAX;
    if (!ok(x, z)) return false;
    let e = dx - dz, n = dx + dz;
    const dx2 = dx * 2, dz2 = dz * 2;
    while (n > 0) {
        if (e > 0) { x += sx; e -= dz2; n--; }
        else if (e < 0) { z += sz; e += dx2; n--; }
        else {
            if (!ok(x + sx, z) || !ok(x, z + sz)) return false;
            x += sx; z += sz; e += dx2 - dz2; n -= 2;
        }
        if (!ok(x, z)) return false;
    }
    return true;
}

// Lazy Theta*: A* that can take straight "any-angle" shortcuts across open floor,
// giving (near-)shortest walking routes instead of grid zig-zags. Works across floors via stairs.
function astar(start, goal, allow) {
    const g = new Float32Array(totalNodes).fill(Infinity);
    const parent = new Int32Array(totalNodes).fill(-1);
    const viaStair = new Uint8Array(totalNodes);
    const closed = new Uint8Array(totalNodes);
    const gf = nodeFloor(goal), gp = cellCenter(gf.grid, goal - gf.offset);
    const h = n => {
        const f = nodeFloor(n), G = f.grid, i = n - f.offset;
        return Math.hypot(G.ox + ((i % G.nx) + 0.5) * CELL - gp.x, G.oz + (Math.floor(i / G.nx) + 0.5) * CELL - gp.y) / CELL;
    };
    const heap = new MinHeap();
    g[start] = 0;
    parent[start] = start;
    heap.push(start, h(start));

    while (heap.size) {
        const cur = heap.pop();
        if (closed[cur]) continue;
        const f = nodeFloor(cur), G = f.grid, i = cur - f.offset;
        const cx = i % G.nx, cz = Math.floor(i / G.nx);
        const cc = cellCost(G, i, allow);

        // The straight line to the parent was assumed when this cell was queued — verify it now.
        const par = parent[cur];
        if (cur !== start && !viaStair[cur] && !(nodeFloor(par) === f && losCells(G, par - f.offset, i, allow))) {
            let best = Infinity, bp = -1, bs = 0;
            for (const [dx, dz, d] of DIRS) {
                const x = cx + dx, z = cz + dz;
                if (x < 0 || z < 0 || x >= G.nx || z >= G.nz) continue;
                const nj = z * G.nx + x, nn = f.offset + nj;
                if (!closed[nn]) continue;
                const c = cellCost(G, nj, allow);
                if (c === Infinity) continue;
                if (dx && dz && (cellCost(G, cz * G.nx + x, allow) === Infinity || cellCost(G, z * G.nx + cx, allow) === Infinity)) continue;
                const v = g[nn] + d * (cc + c) / 2;
                if (v < best) { best = v; bp = nn; }
            }
            const back = portals.get(cur);
            if (back) for (const e of back) if (closed[e.to] && g[e.to] + e.cost < best) { best = g[e.to] + e.cost; bp = e.to; bs = 1; }
            if (bp < 0) continue;
            g[cur] = best; parent[cur] = bp; viaStair[cur] = bs;
        }
        if (cur === goal) break;
        closed[cur] = 1;

        const p = parent[cur];
        const pi = p - f.offset, px = pi % G.nx, pz = Math.floor(pi / G.nx);
        const canShortcut = !viaStair[cur] && cc <= LOS_MAX && cellCost(G, pi, allow) <= LOS_MAX;
        for (const [dx, dz, d] of DIRS) {
            const x = cx + dx, z = cz + dz;
            if (x < 0 || z < 0 || x >= G.nx || z >= G.nz) continue;
            const ni = z * G.nx + x, nn = f.offset + ni;
            if (closed[nn]) continue;
            const c = cellCost(G, ni, allow);
            if (c === Infinity) continue;
            if (dx && dz && (cellCost(G, cz * G.nx + x, allow) === Infinity || cellCost(G, z * G.nx + cx, allow) === Infinity)) continue;
            let ng, np;
            if (canShortcut && c <= LOS_MAX) { ng = g[p] + Math.hypot(x - px, z - pz); np = p; }
            else { ng = g[cur] + d * (cc + c) / 2; np = cur; }
            if (ng < g[nn]) { g[nn] = ng; parent[nn] = np; viaStair[nn] = 0; heap.push(nn, ng + h(nn)); }
        }
        const links = portals.get(cur);
        if (links) for (const e of links) {
            if (closed[e.to]) continue;
            const ng = g[cur] + e.cost;
            if (ng < g[e.to]) { g[e.to] = ng; parent[e.to] = cur; viaStair[e.to] = 1; heap.push(e.to, ng + h(e.to)); }
        }
    }
    if (parent[goal] === -1) return null;
    const path = [];
    for (let n = goal, guard = 0; guard < 1e6; n = parent[n], guard++) { path.push(n); if (n === start) break; }
    return path.reverse();
}

// Fallback straight-line test for stretches over penalised cells (roads, rooms): stay on cells
// no more expensive than the endpoints.
function lineOfSight(floor, a, b, allow) {
    const g = floor.grid;
    const limit = Math.max(cellCost(g, cellOf(g, a), allow), cellCost(g, cellOf(g, b), allow)) + 1e-3;
    const steps = Math.ceil(a.distanceTo(b) / (CELL * 0.35));
    const p = new THREE.Vector2();
    for (let k = 0; k <= steps; k++) {
        p.lerpVectors(a, b, k / steps);
        if (!(cellCost(g, cellOf(g, p), allow) <= limit)) return false;
    }
    return true;
}

// Drop corners that aren't needed (string pulling).
function smoothCells(floor, cells, allow) {
    const G = floor.grid;
    const vis = (a, b) => losCells(G, a, b, allow) || lineOfSight(floor, cellCenter(G, a), cellCenter(G, b), allow);
    const out = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
        let j = cells.length - 1;
        while (j > i + 1 && !vis(cells[i], cells[j])) j--;
        out.push(cells[j]);
        i = j;
    }
    return out;
}

function findRoute(fromKey, toKey) {
    const A = places.get(fromKey), B = places.get(toKey);
    // Hand-drawn walking paths win; the automatic route is only the fallback.
    const drawn = pathNet?.route(A, B);
    if (drawn) return drawn;
    const allow = new Set([A.index, B.index]);
    const s = nearestPassable(A.floor.grid, cellOf(A.floor.grid, A.center), allow, A.floors.length ? A.index : -1);
    const g = nearestPassable(B.floor.grid, cellOf(B.floor.grid, B.center), allow, B.floors.length ? B.index : -1);
    if (s < 0 || g < 0) return null;
    const t0 = performance.now();
    const nodes = astar(A.floor.offset + s, B.floor.offset + g, allow);
    if (!nodes) return null;

    // split into runs per floor, joined by stairs
    const runs = [];
    let run = null;
    for (let k = 0; k < nodes.length; k++) {
        const f = nodeFloor(nodes[k]);
        if (!run || run.floor !== f) {
            if (run) {
                const e = (portals.get(nodes[k - 1]) || []).find(x => x.to === nodes[k]);
                run.stairOut = e ? e.stair : null;
                run.stairLen = e ? e.len : 0;
            }
            run = { floor: f, cells: [] };
            runs.push(run);
        }
        run.cells.push(nodes[k] - f.offset);
    }
    for (const r of runs) {
        const cells = r.cells.length > 1 ? smoothCells(r.floor, r.cells, allow) : r.cells;
        r.pts = cells.map(c => cellCenter(r.floor.grid, c));
        if (r.pts.length === 1) r.pts.push(r.pts[0].clone());
    }
    console.info(`[map] route ${A.key} → ${B.key}: ${runs.reduce((n, r) => n + r.pts.length, 0)} corners, ${runs.length} floor(s), ${(performance.now() - t0).toFixed(0)} ms`);
    return { A, B, runs, allow };
}

/* =========================================================
   DIRECTIONS
========================================================= */

function distToBox2(p, box) {
    const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
    const dz = Math.max(box.min.z - p.y, 0, p.y - box.max.z);
    return Math.hypot(dx, dz);
}

const fmtDist = m => `${Math.max(1, Math.round(m))} m`;
function fmtTime(m) {
    const sec = m / WALK_SPEED_MPS;
    if (sec < 60) return `${Math.max(5, Math.round(sec / 5) * 5)} sec`;
    return `${Math.round(sec / 60)} min`;
}

// Signed angle (degrees) to turn from heading u to heading v. Positive = right (seen walking, y up).
function signedAngle(u, v) {
    return THREE.MathUtils.radToDeg(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y));
}

function turnText(ang) {
    const a = Math.abs(ang), side = ang > 0 ? 'right' : 'left';
    if (a < 50) return `bear <b>${side}</b>`;
    if (a < 135) return `turn <b>${side}</b>`;
    return `make a sharp <b>${side}</b>`;
}

const cap = s => s.replace(/^(<b>)?([a-z])/, (m, b, c) => (b || '') + c.toUpperCase());

// Named walking area (corridor, porch, lobby, open space…) at a point.
function areaName(floor, p) {
    const o = floor.grid.owner[cellOf(floor.grid, p)];
    if (o < 0) return null;
    const pl = placeList_[o];
    return pl.kind === 'walkway' || pl.kind === 'outside' || isLobbyLike(pl.raw) ? pl.name : null;
}

// The area most of a stretch runs through (needs a clear majority).
function stretchArea(floor, a, b) {
    const counts = new Map();
    for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const n = areaName(floor, a.clone().lerp(b, t));
        if (n) counts.set(n, (counts.get(n) || 0) + 1);
    }
    let best = null, bc = 2;
    counts.forEach((c, n) => { if (c > bc) { bc = c; best = n; } });
    return best;
}

// Something you can see at a turn: a room's door right there, or the room you're walking past.
function landmarkAt(floor, p, exclude) {
    let best = null, bestD = 2.5;
    for (const pl of placeList_) {
        if (pl.floor !== floor || exclude.includes(pl) || !pl.isRoom) continue;
        for (const d of pl.doors || []) {
            const dd = d.distanceTo(p);
            if (dd < bestD) { bestD = dd; best = pl; }
        }
    }
    if (best) return `by the door of ${escapeHtml(best.name)}`;
    bestD = 1.2;
    for (const pl of placeList_) {
        if (pl.floor !== floor || exclude.includes(pl) || !pl.isRoom) continue;
        const d = distToBox2(p, pl.box);
        if (d < bestD) { bestD = d; best = pl; }
    }
    return best ? `next to ${escapeHtml(best.name)}` : null;
}

// Outward direction of the wall a door is in (the room side nearest the door point).
function doorNormal(room, pt) {
    const b = room.box;
    const opts = [
        [Math.abs(pt.x - b.min.x), new THREE.Vector2(-1, 0)],
        [Math.abs(pt.x - b.max.x), new THREE.Vector2(1, 0)],
        [Math.abs(pt.y - b.min.z), new THREE.Vector2(0, -1)],
        [Math.abs(pt.y - b.max.z), new THREE.Vector2(0, 1)],
    ];
    return opts.sort((p, q) => p[0] - q[0])[0][1];
}

// The route as one measured polyline (distance s along it), stairs included.
function routeGeometry(runs) {
    const segs = [];
    let s = 0;
    runs.forEach((r, ri) => {
        r.sStart = s;
        for (let i = 0; i < r.pts.length - 1; i++) {
            const a = r.pts[i], b = r.pts[i + 1], L = a.distanceTo(b);
            if (L < 1e-6) continue;
            segs.push({ floor: r.floor, a, b, s0: s, s1: s + L, run: ri });
            s += L;
        }
        r.sEnd = s;
        if (ri < runs.length - 1) s += r.stairLen || 0;
    });
    const at = sv => {
        for (const sg of segs) if (sv <= sg.s1) {
            const t = Math.max(0, Math.min(1, (sv - sg.s0) / (sg.s1 - sg.s0)));
            return { floor: sg.floor, p: sg.a.clone().lerp(sg.b, t) };
        }
        const last = segs[segs.length - 1];
        return last ? { floor: last.floor, p: last.b.clone() } : { floor: runs[0].floor, p: runs[0].pts[0].clone() };
    };
    return { segs, total: s, at };
}

function buildSteps(result) {
    const { A, B, runs } = result;
    const geo = routeGeometry(runs);
    const total = geo.total;
    const ownerAt = q => q.floor.grid.owner[cellOf(q.floor.grid, q.p)];
    const the = n => `the <b>${escapeHtml(n)}</b>`;
    const floorTag = floors.length > 1 ? ` (${A.floor.name})` : '';

    // where the route leaves the start room / enters the destination room
    let sExit = 0, exitPt = null;
    if (A.floors.length) {
        for (let s = 0; s <= Math.min(total, 80); s += 0.1) {
            const q = geo.at(s);
            if (q.floor !== A.floor || ownerAt(q) !== A.index) { sExit = s; exitPt = q.p; break; }
        }
    }
    let sEntry = total, entryPt = null;
    if (B.floors.length) {
        for (let s = total; s >= Math.max(sExit, total - 80); s -= 0.1) {
            const q = geo.at(s);
            if (q.floor !== B.floor || ownerAt(q) !== B.index) { sEntry = s; entryPt = q.p; break; }
        }
    }

    // corners, with little jogs (corners < 1.5 m apart) merged into one turn
    const corners = [];
    geo.segs.forEach((sg, k) => {
        const prev = geo.segs[k - 1];
        if (!prev || prev.run !== sg.run) return;
        const ang = signedAngle(prev.b.clone().sub(prev.a), sg.b.clone().sub(sg.a));
        const last = corners[corners.length - 1];
        if (last && last.run === sg.run && sg.s0 - last.s < 1.5) last.ang += ang;
        else corners.push({ type: 'turn', s: sg.s0, p: sg.a, floor: sg.floor, run: sg.run, ang });
    });
    const afterExit = exitPt ? sExit + 2.5 : 0;
    const beforeEntry = entryPt ? sEntry - 3 : total;
    const events = corners.filter(c => Math.abs(c.ang) >= 25 && c.s > afterExit && c.s < beforeEntry);
    runs.forEach((r, ri) => { if (ri < runs.length - 1) events.push({ type: 'stair', s: r.sEnd, p: r.pts[r.pts.length - 1], floor: r.floor, run: ri }); });
    events.sort((a, b) => a.s - b.s);

    const steps = [];

    // 1. start
    if (exitPt) {
        const out = doorNormal(A, exitPt);
        const ahead = geo.at(Math.min(total, sExit + 2.5)).p.clone().sub(exitPt);
        const ang = signedAngle(out, ahead);
        const move = ahead.lengthSq() < 0.01 || Math.abs(ang) < 30 ? 'go straight ahead' : turnText(ang);
        const area = stretchArea(A.floor, exitPt, geo.at(Math.min(total, sExit + 8)).p);
        steps.push({
            icon: 'start', floor: A.floor, p: exitPt,
            html: `Leave <b>${escapeHtml(A.name)}</b>${floorTag} through the door${sExit > 4 ? ` (${fmtDist(sExit)})` : ''}, then ${move}${area ? ` into ${the(area)}` : ''}`,
        });
    } else {
        steps.push({ icon: 'start', floor: A.floor, p: runs[0].pts[0], html: `Start at <b>${escapeHtml(A.name)}</b>${floorTag}` });
    }

    // 2. turns and stairs
    let prevS = exitPt ? sExit : 0, prefix = '';
    events.forEach((ev, k) => {
        const d = ev.s - prevS;
        const q0 = geo.at(prevS + 0.05);
        const along = q0.floor === ev.floor ? stretchArea(ev.floor, q0.p, ev.p) : null;
        const walk = d >= 1.5 ? `walk ${fmtDist(d)}${along ? ` along ${the(along)}` : ''}, then ` : '';
        if (ev.type === 'turn') {
            const nextS = k + 1 < events.length ? events[k + 1].s : (entryPt ? sEntry : total);
            const into = stretchArea(ev.floor, ev.p, geo.at(Math.min(nextS, ev.s + 8)).p);
            let lm = landmarkAt(ev.floor, ev.p, [A, B]);
            if (lm && [along, into].some(n => n && lm.endsWith(escapeHtml(n)))) lm = null;   // don't repeat the area name
            steps.push({
                icon: ev.ang > 0 ? 'right' : 'left', floor: ev.floor, p: ev.p,
                html: cap(prefix + walk + turnText(ev.ang) + (into && into !== along ? ` into ${the(into)}` : '') + (lm ? ` ${lm}` : '')),
            });
            prevS = ev.s;
            prefix = '';
        } else {
            const next = runs[ev.run + 1];
            const up = next.floor.elevation > ev.floor.elevation;
            const stair = runs[ev.run].stairOut;
            steps.push({
                icon: up ? 'up' : 'down', floor: ev.floor, p: ev.p,
                html: cap(prefix + (d >= 1.5 ? `walk ${fmtDist(d)}${along ? ` along ${the(along)}` : ''} to ` : 'go to ') +
                    `<b>${escapeHtml(stair ? stair.name : 'the stairs')}</b> and take the stairs <b>${up ? 'up' : 'down'}</b> to the <b>${escapeHtml(next.floor.name)}</b>`),
            });
            prevS = next.sStart;
            prefix = up ? 'at the top of the stairs, ' : 'at the bottom of the stairs, ';
        }
    });

    // 3. arrival
    const endS = entryPt ? sEntry : total;
    const d = endS - prevS;
    const q0 = geo.at(prevS + 0.05), qEnd = geo.at(endS);
    const along = q0.floor === qEnd.floor ? stretchArea(qEnd.floor, q0.p, qEnd.p) : null;
    const walk = d >= 1.5 ? `walk ${fmtDist(d)}${along ? ` along ${the(along)}` : ''}` : '';
    let html;
    if (entryPt) {
        const heading = entryPt.clone().sub(geo.at(Math.max(prevS, sEntry - 3)).p);
        const inward = doorNormal(B, entryPt).negate();
        const ang = heading.lengthSq() < 0.01 ? 0 : signedAngle(heading, inward);
        const where = Math.abs(ang) < 40 ? 'straight ahead' : `on your <b>${ang > 0 ? 'right' : 'left'}</b>`;
        html = cap(prefix + (walk ? `${walk}: ` : '') + `<b>${escapeHtml(B.name)}</b> is ${where} — go in through the door`);
    } else {
        html = cap(prefix + (walk ? `${walk} to arrive at ` : 'you have arrived at ') + `<b>${escapeHtml(B.name)}</b>`);
    }
    steps.push({ icon: 'goal', floor: B.floor, p: entryPt || runs[runs.length - 1].pts.at(-1), html });
    return { steps, total };
}

/* =========================================================
   ROUTE VISUALS
========================================================= */

function makePin(color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 });
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 8), mat);
    stick.position.y = 1.3;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 16), mat);
    head.position.y = 2.9;
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.7, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    g.add(stick, head, ring);
    g.userData = { ring, head };
    stick.castShadow = head.castShadow = true;
    return g;
}

function clearRoute() {
    if (!route) return;
    scene.remove(route.group);
    route.group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
    route = null;
    refreshHighlights();
}

function drawRoute(result) {
    clearRoute();
    const { A, B, runs } = result;
    const group = new THREE.Group();

    // 3D points following each floor's height; stairs are the straight links between runs
    const v3 = [];
    for (const r of runs) {
        const pts = r.pts;
        for (let i = 0; i < pts.length - 1; i++) {
            const n = Math.max(1, Math.ceil(pts[i].distanceTo(pts[i + 1]) / 0.5));
            for (let k = 0; k < n; k++) {
                const p = pts[i].clone().lerp(pts[i + 1], k / n);
                v3.push(new THREE.Vector3(p.x, heightAt(r.floor, p) + PATH_LIFT, p.y));
            }
        }
        const last = pts[pts.length - 1];
        v3.push(new THREE.Vector3(last.x, heightAt(r.floor, last) + PATH_LIFT, last.y));
    }
    for (let i = v3.length - 1; i > 0; i--) if (v3[i].distanceToSquared(v3[i - 1]) < 1e-6) v3.splice(i, 1);
    if (v3.length < 2) v3.push(v3[0].clone().add(new THREE.Vector3(0.01, 0, 0)));

    const curve = new THREE.CurvePath();
    for (let i = 0; i < v3.length - 1; i++) curve.add(new THREE.LineCurve3(v3[i], v3[i + 1]));
    const length = curve.getLength();
    const tubeGeo = new THREE.TubeGeometry(curve, Math.max(32, v3.length * 3), 0.15, 10, false);

    group.add(new THREE.Mesh(tubeGeo,
        new THREE.MeshStandardMaterial({ color: 0x0a8a47, emissive: 0x08733b, emissiveIntensity: 0.6, roughness: 0.5 })));
    // faint copy drawn on top of everything so the route stays visible through floors and walls
    const ghost = new THREE.Mesh(tubeGeo.clone(),
        new THREE.MeshBasicMaterial({ color: 0x0a8a47, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }));
    ghost.renderOrder = 10;
    group.add(ghost);

    const arrowGeo = new THREE.ConeGeometry(0.22, 0.55, 12);
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const arrows = [];
    for (let k = 0; k < Math.max(1, Math.floor(length / 2)); k++) {
        const a = new THREE.Mesh(arrowGeo, arrowMat);
        a.userData.offset = k * 2;
        group.add(a);
        arrows.push(a);
    }

    const walker = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 20, 16),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x3ddc84, emissiveIntensity: 0.6 })
    );
    walker.castShadow = true;
    group.add(walker);

    const startPin = makePin(0x08733b);
    startPin.position.copy(v3[0]).setY(v3[0].y - PATH_LIFT);
    const endPin = makePin(0xc62828);
    endPin.position.copy(v3[v3.length - 1]).setY(v3[v3.length - 1].y - PATH_LIFT);
    group.add(startPin, endPin);

    scene.add(group);
    const { steps, total } = buildSteps(result);
    route = { A, B, runs, curve, length, group, arrows, walker, endPin, startPin, steps, total };
    setActiveFloor(B.floor.id, false);
    refreshHighlights();
    fitBox(new THREE.Box3().setFromPoints(v3), true, 1.5);
}

const tmpTangent = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function animateRoute(t) {
    if (!route) return;
    const { curve, length, arrows, walker, endPin, startPin } = route;
    const flow = (t * 2) % length;
    for (const a of arrows) {
        const u = ((a.userData.offset + flow) % length) / length;
        curve.getPointAt(u, a.position);
        a.position.y += 0.03;
        curve.getTangentAt(u, tmpTangent);
        a.quaternion.setFromUnitVectors(UP, tmpTangent.normalize());
    }
    const speed = 6;
    const travel = length / speed + 1.5;
    curve.getPointAt(Math.min(1, (t % travel) / (length / speed)), walker.position);
    walker.position.y += 0.2;

    const bob = Math.sin(t * 3) * 0.2;
    endPin.userData.head.position.y = 2.9 + bob;
    startPin.userData.head.position.y = 2.9 - bob * 0.5;
    const k = (t * 0.8) % 1;
    endPin.userData.ring.scale.setScalar(1 + k * 2);
    endPin.userData.ring.material.opacity = 0.7 * (1 - k);
}

/* =========================================================
   PERFORMANCE: merge thousands of small meshes into a few batches
========================================================= */

function optimiseMeshes(floor) {
    const root = floor.root;
    root.updateMatrixWorld(true);
    const keep = new Set(floor.pickables);
    const batches = new Map();
    const remove = [];
    root.traverse(o => {
        if (!o.isMesh || keep.has(o) || Array.isArray(o.material)) return;
        const kind = partKind(o, root);
        const isWall = kind === 'wall' || kind === 'header';
        const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        geo.applyMatrix4(o.matrixWorld);
        for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
        const sig = Object.keys(geo.attributes).sort().join(',');
        const key = `${isWall ? 'wall' : 'obj'}|${o.material.uuid}|${sig}`;
        if (!batches.has(key)) batches.set(key, { material: o.material, isWall, geos: [] });
        batches.get(key).geos.push(geo);
        remove.push(o);
    });
    for (const o of remove) { o.parent.remove(o); o.geometry.dispose(); }

    const merged = new THREE.Group();
    merged.name = `merged-${floor.short}`;
    for (const b of batches.values()) {
        const geo = mergeGeometries(b.geos, false);
        b.geos.forEach(g => g.dispose());
        if (!geo) continue;
        let mat = b.material;
        if (b.isWall) { mat = mat.clone(); floor.wallMaterials.push(mat); }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        merged.add(mesh);
    }
    scene.add(merged);
    floor.merged = merged;

    for (const m of floor.pickables) {
        m.material = Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone();
        m.userData.baseEmissive = (Array.isArray(m.material) ? m.material[0] : m.material).emissive?.clone();
        m.receiveShadow = true;
    }
    console.info(`[map] ${floor.name}: merged ${remove.length} meshes into ${merged.children.length} batches`);
}

function setupLightsAndCamera() {
    const all = new THREE.Box3();
    floors.forEach(f => all.union(new THREE.Box3().setFromObject(f.root)));
    const c = all.getCenter(new THREE.Vector3());
    const size = all.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z) * 0.6;
    sun.position.set(c.x - r * 0.4, c.y + r * 1.2, c.z + r * 0.6);
    sun.target.position.copy(c);
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: r * 4 });
    sun.shadow.camera.updateProjectionMatrix();
    controls.maxDistance = r * 3.5;
    camera.far = r * 12;
    camera.updateProjectionMatrix();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(r * 20, r * 20), new THREE.MeshLambertMaterial({ color: 0xcfdcc9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(c.x, all.min.y - 0.05, c.z);
    scene.add(ground);
    camera.position.set(c.x, c.y + r, c.z + r);
    controls.target.copy(c);
    fitBox(campusBox, false);
}

/* =========================================================
   FLOORS, HIGHLIGHTS, X-RAY
========================================================= */

function setActiveFloor(id, refresh = true) {
    activeFloor = id;
    for (const f of floors) {
        const shown = f.id <= id;           // floors below stay visible underneath
        f.root.visible = shown;
        if (f.merged) f.merged.visible = shown;
    }
    floorSwitch.querySelectorAll('button').forEach(b => {
        const on = +b.dataset.floor === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on);
    });
    if (refresh) refreshHighlights();
    else updateLabelVisibility();
    pathNet?.refresh();
}

function updateLabelVisibility() {
    for (const f of floors) for (const l of f.labels) l.visible = f.id === activeFloor;
    if (route) { route.A.labelObj.visible = true; route.B.labelObj.visible = true; }
    const sel = selectedKey && places.get(selectedKey);
    if (sel) sel.labelObj.visible = true;
}

function eachMat(m, fn) { (Array.isArray(m.material) ? m.material : [m.material]).forEach(fn); }

function setPlaceTint(p, color, intensity) {
    const meshes = p.floors.length ? p.floors : p.floor.pickables.filter(m => m.userData.placeKey === p.key);
    for (const m of meshes) eachMat(m, mat => { if (mat.emissive) { mat.emissive.set(color); mat.emissiveIntensity = intensity; } });
}

function refreshHighlights() {
    for (const f of floors) for (const m of f.pickables) eachMat(m, mat => {
        if (mat.emissive) { mat.emissive.copy(m.userData.baseEmissive || new THREE.Color(0)); mat.emissiveIntensity = 1; }
    });
    for (const p of places.values()) p.label.classList.remove('from', 'to', 'selected');
    const sel = selectedKey && places.get(selectedKey);
    if (sel) { setPlaceTint(sel, 0xf2b400, 0.45); sel.label.classList.add('selected'); }
    if (route) {
        setPlaceTint(route.A, 0x08733b, 0.5);
        setPlaceTint(route.B, 0xc62828, 0.5);
        route.A.label.classList.add('from');
        route.B.label.classList.add('to');
    }
    updateLabelVisibility();
    applyXray();
}

function applyXray() {
    const on = xray || !!route;
    for (const f of floors) for (const mat of f.wallMaterials) {
        mat.transparent = on;
        mat.opacity = on ? 0.3 : 1;
        mat.depthWrite = !on;
        mat.needsUpdate = true;
    }
}

/* =========================================================
   CAMERA
========================================================= */

function fitBox(box, animate = true, pad = 1.2, topDown = false) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, 8) * 0.5;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = Math.min(camera.aspect, 1.6);
    let dist = (radius / Math.tan(fov / 2)) * pad / Math.min(1, aspect);
    dist = THREE.MathUtils.clamp(dist, controls.minDistance + 1, controls.maxDistance);
    let dir;
    if (topDown) {
        dir = new THREE.Vector3(0, 1, 0.02).normalize();
    } else {
        const h = new THREE.Vector2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
        if (h.lengthSq() < 1e-4) h.set(0, 1);
        h.normalize();
        dir = new THREE.Vector3(h.x * 0.62, 0.78, h.y * 0.62).normalize();
    }
    flyTo(center, center.clone().addScaledVector(dir, dist), animate);
}

function flyTo(target, position, animate = true) {
    if (!animate) {
        controls.target.copy(target);
        camera.position.copy(position);
        controls.update();
        tween = null;
        return;
    }
    tween = {
        t0: performance.now(), dur: 900,
        fromT: controls.target.clone(), toT: target.clone(),
        fromP: camera.position.clone(), toP: position.clone(),
    };
}

function updateTween(now) {
    if (!tween) return;
    const k = Math.min(1, (now - tween.t0) / tween.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    controls.target.lerpVectors(tween.fromT, tween.toT, e);
    camera.position.lerpVectors(tween.fromP, tween.toP, e);
    if (k >= 1) tween = null;
}

function focusPlace(p) {
    const box = p.box.clone();
    box.expandByScalar(4);
    fitBox(box, true, 1.4);
}

/* =========================================================
   UI
========================================================= */

const groupLabel = p => (floors.length > 1 ? `${p.floor.name} · ${p.category}` : p.category);
const CAT_RANK = c => (c === 'Corridors & Lobbies' ? 1 : c === 'Stairs' ? 2 : c === 'Outside' ? 3 : 0);

function sortedPlaces() {
    return [...places.values()].sort((a, b) =>
        a.floor.id - b.floor.id || CAT_RANK(a.category) - CAT_RANK(b.category) ||
        naturalCompare(a.category, b.category) || naturalCompare(a.name, b.name));
}

function buildUI() {
    for (const f of floors) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.floor = f.id;
        b.textContent = f.name;
        b.addEventListener('click', () => setActiveFloor(f.id));
        floorSwitch.appendChild(b);
    }
    floorSwitch.hidden = floors.length < 2;   // single-storey building: nothing to switch
    for (const sel of [fromSelect, toSelect]) {
        let group = null, cat = null;
        for (const p of sortedPlaces()) {
            const gl = groupLabel(p);
            if (gl !== cat) {
                cat = gl;
                group = document.createElement('optgroup');
                group.label = gl;
                sel.appendChild(group);
            }
            group.appendChild(new Option(p.name, p.key));
        }
    }
    renderPlaceList('');
}

function renderPlaceList(query) {
    const q = query.trim().toLowerCase();
    placeList.innerHTML = '';
    let cat = null, groupEl = null, count = 0;
    for (const p of sortedPlaces()) {
        const gl = groupLabel(p);
        if (q && !p.name.toLowerCase().includes(q) && !p.raw.toLowerCase().includes(q) && !gl.toLowerCase().includes(q)) continue;
        if (gl !== cat) {
            cat = gl;
            groupEl = document.createElement('div');
            groupEl.className = 'place-group';
            groupEl.innerHTML = `<h3>${escapeHtml(gl)}</h3>`;
            placeList.appendChild(groupEl);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'place-item' + (p.key === selectedKey ? ' selected' : '');
        btn.textContent = p.name;
        btn.addEventListener('click', () => selectPlace(p.key, true));
        groupEl.appendChild(btn);
        count++;
    }
    if (!count) placeList.innerHTML = '<p class="empty">No places match your search.</p>';
}

function selectPlace(key, fly = false) {
    const p = places.get(key);
    if (!p) { deselect(); return; }
    selectedKey = key;
    $('infoName').textContent = p.name;
    $('infoCat').textContent = groupLabel(p);
    infoCard.hidden = false;
    if (p.floor.id !== activeFloor) setActiveFloor(p.floor.id, false);
    refreshHighlights();
    renderPlaceList(searchInput.value);
    if (fly) focusPlace(p);
}

function deselect() {
    selectedKey = null;
    infoCard.hidden = true;
    refreshHighlights();
    renderPlaceList(searchInput.value);
}

function showRoute(fromKey, toKey) {
    routeError.hidden = true;
    if (!fromKey || !toKey || !places.has(fromKey) || !places.has(toKey)) return;
    if (fromKey === toKey) {
        routeError.textContent = 'Your start and destination are the same place.';
        routeError.hidden = false;
        return;
    }
    const result = findRoute(fromKey, toKey);
    if (!result) {
        clearRoute();
        routeResult.hidden = true;
        routeError.textContent = `Sorry, no walking route was found to ${places.get(toKey).name}.`;
        routeError.hidden = false;
        return;
    }
    selectedKey = null;
    infoCard.hidden = true;
    drawRoute(result);

    $('sumDist').textContent = fmtDist(route.total);
    $('sumTime').textContent = fmtTime(route.total);
    stepsEl.innerHTML = '';
    route.steps.forEach(s => {
        const li = document.createElement('li');
        const icon = { start: 'A', goal: 'B', left: '↰', right: '↱', up: '↑', down: '↓' }[s.icon];
        li.innerHTML = `<span class="step-icon ${s.icon}">${icon}</span><span>${s.html}</span>`;
        li.addEventListener('click', () => {
            stepsEl.querySelectorAll('li').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
            setActiveFloor(s.floor.id);
            const c = new THREE.Vector3(s.p.x, heightAt(s.floor, s.p), s.p.y);
            fitBox(new THREE.Box3(c.clone().subScalar(5), c.clone().addScalar(5)), true, 1.3);
        });
        stepsEl.appendChild(li);
    });
    routeResult.hidden = false;

    const url = new URL(location.href);
    url.searchParams.set('from', fromKey);
    url.searchParams.set('to', toKey);
    history.replaceState(null, '', url);
}

// Accept "2:Classroom_211" as well as old links without a floor ("Library" → ground floor).
const resolveKey = k => (!k ? null : places.has(k) ? k : places.has(`1:${k}`) ? `1:${k}` : null);

function applyUrlParams() {
    const params = new URLSearchParams(location.search);
    const from = resolveKey(params.get('from')), to = resolveKey(params.get('to'));
    if (from) fromSelect.value = from;
    if (to) toSelect.value = to;
    if (from && to) showRoute(from, to);
    else if (to) selectPlace(to, true);
}

$('routeForm').addEventListener('submit', e => {
    e.preventDefault();
    showRoute(fromSelect.value, toSelect.value);
});

$('swapBtn').addEventListener('click', () => {
    [fromSelect.value, toSelect.value] = [toSelect.value, fromSelect.value];
    if (fromSelect.value && toSelect.value) showRoute(fromSelect.value, toSelect.value);
});

$('clearBtn').addEventListener('click', () => {
    fromSelect.value = '';
    toSelect.value = '';
    routeResult.hidden = true;
    routeError.hidden = true;
    clearRoute();
    history.replaceState(null, '', location.pathname + (SITE === 'main' ? '' : `?site=${SITE}`));
    if (campusBox) fitBox(campusBox);
});

$('copyLinkBtn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    try {
        await navigator.clipboard.writeText(location.href);
        btn.textContent = 'Copied!';
    } catch {
        btn.textContent = 'Copy failed';
    }
    setTimeout(() => (btn.textContent = 'Copy link'), 1600);
});

searchInput.addEventListener('input', () => renderPlaceList(searchInput.value));

$('infoClose').addEventListener('click', deselect);
$('infoFrom').addEventListener('click', () => {
    fromSelect.value = selectedKey;
    if (toSelect.value && toSelect.value !== selectedKey) showRoute(fromSelect.value, toSelect.value);
    else { deselect(); toSelect.focus(); }
});
$('infoTo').addEventListener('click', () => {
    toSelect.value = selectedKey;
    if (fromSelect.value && fromSelect.value !== selectedKey) showRoute(fromSelect.value, toSelect.value);
    else { deselect(); fromSelect.focus(); }
});

$('resetViewBtn').addEventListener('click', () => campusBox && fitBox(campusBox));
$('topViewBtn').addEventListener('click', () => campusBox && fitBox(campusBox, true, 1.05, true));
$('xrayBtn').addEventListener('click', e => {
    xray = !xray;
    e.currentTarget.classList.toggle('on', xray);
    e.currentTarget.setAttribute('aria-pressed', xray);
    applyXray();
});
$('labelsBtn').addEventListener('click', e => {
    const on = labelRenderer.domElement.classList.toggle('hide-labels') === false;
    e.currentTarget.classList.toggle('on', on);
    e.currentTarget.setAttribute('aria-pressed', on);
});

window.addEventListener('keydown', e => {
    if (e.key === 'Escape') deselect();
});

/* ---------- Click / hover picking (active floor only) ---------- */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;

function pick(ev) {
    const f = floorById(activeFloor);
    if (!f || !f.pickables.length) return null;
    const r = labelRenderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(f.pickables, false);
    const room = hits.find(h => places.get(h.object.userData.placeKey)?.isRoom);
    return (room || hits[0])?.object.userData.placeKey || null;
}

labelRenderer.domElement.addEventListener('pointerdown', e => (downPos = [e.clientX, e.clientY]));
labelRenderer.domElement.addEventListener('pointerup', e => {
    if (pathNet?.editing) return;   // clicks draw paths instead
    if (!downPos || Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5) return;
    const key = pick(e);
    if (key) selectPlace(key);
    else deselect();
});
let hoverPending = false;
labelRenderer.domElement.addEventListener('pointermove', e => {
    if (e.buttons || hoverPending) return;
    if (pathNet?.editing) { labelRenderer.domElement.style.cursor = 'crosshair'; return; }
    hoverPending = true;
    requestAnimationFrame(() => {
        hoverPending = false;
        labelRenderer.domElement.style.cursor = pick(e) ? 'pointer' : 'grab';
    });
});

/* =========================================================
   RENDER LOOP
========================================================= */

const clock = new THREE.Clock();
let lastFar = null;
// Nothing is drawn until loading has finished: the raw models are thousands of small meshes
// (merged into a few batches at the end), and drawing them even once takes several seconds.
let sceneReady = false;
renderer.setAnimationLoop(() => {
    if (!sceneReady) return;
    const t = clock.getElapsedTime();
    updateTween(performance.now());
    controls.update();
    animateRoute(t);
    if (campusBox) {
        const far = camera.position.distanceTo(controls.target) > Math.max(60, campusBox.getSize(new THREE.Vector3()).x * 0.9);
        if (far !== lastFar) { labelRenderer.domElement.classList.toggle('far', far); lastFar = far; }
    }
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
});

// Handy for debugging in the browser console.
window.campusMap = { places, floors, portals, camera, findRoute, showRoute, setActiveFloor, get pathNet() { return pathNet; } };
