// Fetches suggested routes between the two campuses from OpenStreetMap data (FOSSGIS OSRM routing
// service) and saves them to osm-routes.json, which the campus-to-campus map shows next to the
// hand-drawn routes. Done once here rather than by every visitor's browser: faster, works if the
// service is down, and visitors' browsers never contact it. Run again to refresh:
//   node tools/fetch-osm-routes.mjs
// Only the two fixed campus coordinates are sent.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'osm-routes.json');
const MAIN = { lat: 20.450983751626257, lng: 121.96859583684216 };   // same pins as campus-link.js
const AGRI = { lat: 20.454265489133476, lng: 121.97410688505313 };
const PROFILES = { walking: 'foot', driving: 'car' };

const out = {
    source: 'Routes from OpenStreetMap data (© OpenStreetMap contributors), routing by routing.openstreetmap.de (FOSSGIS OSRM)',
    fetched: new Date().toISOString().slice(0, 10),
};
for (const [mode, profile] of Object.entries(PROFILES)) {
    const url = `https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/` +
        `${MAIN.lng},${MAIN.lat};${AGRI.lng},${AGRI.lat}?alternatives=3&overview=full&geometries=geojson&steps=false`;
    const res = await fetch(url, { headers: { 'User-Agent': 'campus-navigator-route-tool' } });
    if (!res.ok) throw new Error(`${mode}: HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error(`${mode}: ${data.code} ${data.message || ''}`);
    // How far each end is from the campus pin (where the mapped paths/roads stop).
    const [w0, w1] = data.waypoints;
    out[mode] = data.routes.map(r => ({
        distance: Math.round(r.distance),
        points: r.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(6), +lng.toFixed(6)]),
        gapStart: Math.round(w0.distance),   // metres from the main campus pin to where the route starts
        gapEnd: Math.round(w1.distance),     // metres from where the route ends to the Agri Lab pin
    }));
    console.log(`${mode}: ${out[mode].map(r => `${r.distance} m (ends ${r.gapEnd} m from the Agri Lab pin)`).join(', ')}`);
}
// One point per line, like campus-route.json.
const routeJson = r => `   {"distance": ${r.distance}, "gapStart": ${r.gapStart}, "gapEnd": ${r.gapEnd}, "points": [` +
    r.points.map(p => `\n    [${p[0].toFixed(6)}, ${p[1].toFixed(6)}]`).join(',') + '\n   ]}';
fs.writeFileSync(OUT, '{\n' +
    ` "source": ${JSON.stringify(out.source)},\n "fetched": "${out.fetched}",\n` +
    Object.keys(PROFILES).map(m => ` "${m}": [\n${out[m].map(routeJson).join(',\n')}\n ]`).join(',\n') + '\n}\n');
console.log(`Saved ${OUT}`);
