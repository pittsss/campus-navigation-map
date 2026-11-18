// Converts the 3D models (models/*.fbx) into the map's compact format (models/*.model.gz, read by
// model-format.js), then reads each result back and checks it matches the original. Also writes the
// gzip-compressed .fbx.gz copies the map falls back to. Run again whenever a model changes:
//   node tools/build-models.mjs
import { registerHooks } from 'node:module';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'models');

// Same three.js the site uses (vendor/three); the add-ons import the bare name 'three'.
const threeUrl = pathToFileURL(path.join(ROOT, 'vendor/three/three.module.min.js')).href;
registerHooks({
    resolve(spec, ctx, next) {
        return spec === 'three' ? { url: threeUrl, shortCircuit: true } : next(spec, ctx);
    },
});
const THREE = await import('three');
const { FBXLoader } = await import(pathToFileURL(path.join(ROOT, 'vendor/three/addons/loaders/FBXLoader.js')).href);
const { parseModel, MODEL_MAGIC } = await import(pathToFileURL(path.join(ROOT, 'model-format.js')).href);

/* ---------- encode ---------- */

function encode(root) {
    const materials = [], matIndex = new Map();
    const geometries = [], geoIndex = new Map();
    const chunks = [];
    let offset = 0;
    const push = typed => {
        const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
        const at = offset;
        chunks.push(bytes);
        offset += bytes.length;
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
        return at;
    };
    const mat = m => {
        if (!matIndex.has(m)) {
            if (m.map || m.normalMap || m.bumpMap || m.alphaMap || m.emissiveMap || m.specularMap)
                throw new Error(`material "${m.name}" has a texture — the compact format doesn't store textures`);
            const json = m.toJSON();
            delete json.metadata;
            // toJSON rounds colours to 8 bits; keep the exact values too (restored by model-format.js).
            json.exact = Object.fromEntries(['color', 'emissive', 'specular'].filter(k => m[k]?.isColor).map(k => [k, m[k].toArray()]));
            matIndex.set(m, materials.length);
            materials.push(json);
        }
        return matIndex.get(m);
    };
    const geo = g => {
        if (geoIndex.has(g)) return geoIndex.get(g);
        if (g.index) throw new Error('indexed geometry not expected from FBXLoader');
        const pos = g.attributes.position.array, nrm = g.attributes.normal?.array;
        const count = g.attributes.position.count;
        // Are all faces flat (each corner's normal = its triangle's face normal)? Then normals needn't be stored.
        let flat = !!nrm && count % 3 === 0;
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
        for (let t = 0; flat && t < count; t += 3) {
            a.fromArray(pos, t * 3); b.fromArray(pos, t * 3 + 3); c.fromArray(pos, t * 3 + 6);
            n.subVectors(c, b).cross(a.clone().sub(b)).normalize();   // same as computeVertexNormals
            if (n.lengthSq() === 0) continue;                         // degenerate triangle: no shading anyway
            for (let k = 0; k < 3; k++) {
                const i = (t + k) * 3;
                if (n.x * nrm[i] + n.y * nrm[i + 1] + n.z * nrm[i + 2] < 0.999) { flat = false; break; }
            }
        }
        // Share identical corners (same position, and same normal when normals are stored).
        const keyOf = i => flat || !nrm
            ? `${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}`
            : `${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}|${Math.round(nrm[i * 3] * 127)},${Math.round(nrm[i * 3 + 1] * 127)},${Math.round(nrm[i * 3 + 2] * 127)}`;
        const seen = new Map(), uniq = [], index = new Array(count);
        for (let i = 0; i < count; i++) {
            const k = keyOf(i);
            let v = seen.get(k);
            if (v === undefined) { v = uniq.length; seen.set(k, v); uniq.push(i); }
            index[i] = v;
        }
        const upos = new Float32Array(uniq.length * 3);
        uniq.forEach((src, v) => upos.set(pos.subarray(src * 3, src * 3 + 3), v * 3));
        const i32 = uniq.length > 65536;
        const delta = i32 ? new Int32Array(count) : new Int16Array(count);
        let prev = 0;
        for (let i = 0; i < count; i++) {
            delta[i] = i32 ? index[i] - prev : ((index[i] - prev) & 0xffff) << 16 >> 16;
            prev = index[i];
        }
        const entry = { n: uniq.length, i: count, i32, pos: push(upos), idx: push(delta), nrm: null, groups: g.groups.map(x => [x.start, x.count, x.materialIndex]) };
        if (!flat && nrm) {
            const q = new Int8Array(count * 3);
            for (let i = 0; i < count * 3; i++) q[i] = Math.round(Math.max(-1, Math.min(1, nrm[i])) * 127);
            entry.nrm = push(q);
        }
        geoIndex.set(g, geometries.length);
        geometries.push(entry);
        return geoIndex.get(g);
    };
    const r = v => +v.toPrecision(9);
    const node = o => {
        if (!o.isMesh && !o.isGroup && o.type !== 'Object3D') console.warn(`  (stored ${o.type} "${o.name}" as a group)`);
        const out = { n: o.name };
        if (o.isMesh) {
            out.t = 'M';
            out.g = geo(o.geometry);
            out.m = Array.isArray(o.material) ? o.material.map(mat) : mat(o.material);
        } else out.t = 'G';
        if (o.position.lengthSq()) out.p = o.position.toArray().map(r);
        if (o.quaternion.w !== 1) out.q = o.quaternion.toArray().map(r);
        if (o.scale.x !== 1 || o.scale.y !== 1 || o.scale.z !== 1) out.s = o.scale.toArray().map(r);
        if (o.children.length) out.c = o.children.map(node);
        return out;
    };
    const tree = node(root);
    const json = new TextEncoder().encode(JSON.stringify({ version: 1, materials, geometries, root: tree }));
    const head = new Uint8Array(8);
    head.set([...MODEL_MAGIC].map(ch => ch.charCodeAt(0)));
    new DataView(head.buffer).setUint32(4, json.length, true);
    const pad = new Uint8Array((4 - ((8 + json.length) % 4)) % 4);
    return Buffer.concat([head, json, pad, ...chunks]);
}

/* ---------- check: the converted model must match what FBXLoader builds ---------- */

function compare(a, b, file) {
    a.updateMatrixWorld(true);
    b.updateMatrixWorld(true);
    const la = [], lb = [];
    a.traverse(o => la.push(o));
    b.traverse(o => lb.push(o));
    if (la.length !== lb.length) throw new Error(`${file}: ${la.length} objects vs ${lb.length}`);
    let worst = 0, worstN = 0, zeroArea = 0;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3();
    for (let k = 0; k < la.length; k++) {
        const x = la[k], y = lb[k];
        if (x.name !== y.name || !!x.isMesh !== !!y.isMesh) throw new Error(`${file}: object ${k} "${x.name}" vs "${y.name}"`);
        if (!x.isMesh) continue;
        const ga = x.geometry, gb = y.geometry;
        if (ga.attributes.position.count !== gb.attributes.position.count) throw new Error(`${file}: "${x.name}" vertex count differs`);
        if (JSON.stringify(ga.groups) !== JSON.stringify(gb.groups)) throw new Error(`${file}: "${x.name}" material groups differ`);
        const ma = [x.material].flat(), mb = [y.material].flat();
        const same = (c, d) => !c === !d && (!c || Math.max(Math.abs(c.r - d.r), Math.abs(c.g - d.g), Math.abs(c.b - d.b)) < 1e-6);
        const close = (u, v) => u === v || Math.abs(u - v) < 1e-6;
        if (ma.length !== mb.length) throw new Error(`${file}: "${x.name}" material count differs`);
        ma.forEach((m, i) => {
            const n = mb[i];
            const diff = [
                m.type !== n.type && 'type', m.name !== n.name && 'name',
                !same(m.color, n.color) && 'color', !same(m.emissive, n.emissive) && 'emissive', !same(m.specular, n.specular) && 'specular',
                !close(m.shininess, n.shininess) && 'shininess', !close(m.opacity, n.opacity) && 'opacity',
                m.transparent !== n.transparent && 'transparent', m.side !== n.side && 'side', m.flatShading !== n.flatShading && 'flatShading',
                m.vertexColors !== n.vertexColors && 'vertexColors', m.depthWrite !== n.depthWrite && 'depthWrite',
            ].filter(Boolean);
            if (diff.length) throw new Error(`${file}: "${x.name}" material "${m.name}" differs in ${diff.join(', ')}: ` +
                diff.map(k => `${JSON.stringify(m[k])} vs ${JSON.stringify(n[k])}`).join('; '));
        });
        const A = ga.attributes, B = gb.attributes;
        for (let i = 0; i < A.position.count; i++) {
            pa.fromBufferAttribute(A.position, i).applyMatrix4(x.matrixWorld);
            pb.fromBufferAttribute(B.position, i).applyMatrix4(y.matrixWorld);
            worst = Math.max(worst, pa.distanceTo(pb));
            // Zero-area triangles get no normal when worked out again; they can't be seen, so skip them.
            if (Math.hypot(B.normal.getX(i), B.normal.getY(i), B.normal.getZ(i)) < 0.5) { zeroArea++; continue; }
            const dot = A.normal.getX(i) * B.normal.getX(i) + A.normal.getY(i) * B.normal.getY(i) + A.normal.getZ(i) * B.normal.getZ(i);
            if (Number.isFinite(dot)) worstN = Math.max(worstN, 1 - dot);
        }
    }
    // Shared materials must stay shared (the map batches meshes by material).
    const count = r => { const s = new Set(); r.traverse(o => o.isMesh && [o.material].flat().forEach(m => s.add(m))); return s.size; };
    if (count(a) !== count(b)) throw new Error(`${file}: ${count(a)} materials vs ${count(b)}`);
    if (worstN > 1e-3) throw new Error(`${file}: shading differs (normal difference ${worstN})`);
    if (worst > 1e-6) throw new Error(`${file}: shapes differ (position difference ${worst})`);
    return { objects: la.length, worst, worstNormal: worstN, zeroArea };
}

/* ---------- run ---------- */

const mb = n => (n / 1048576).toFixed(2) + ' MB';
const files = fs.readdirSync(MODELS).filter(n => n.toLowerCase().endsWith('.fbx'));
for (const name of files) {
    const src = path.join(MODELS, name);
    const raw = fs.readFileSync(src);
    const t0 = Date.now();
    const original = new FBXLoader().parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length), '');
    const parseMs = Date.now() - t0;

    const packed = encode(original);
    const gz = zlib.gzipSync(packed, { level: 9 });
    const t1 = Date.now();
    const back = parseModel(zlib.gunzipSync(gz).buffer.slice(0));
    const readMs = Date.now() - t1;
    const check = compare(original, back, name);

    const base = name.replace(/\.fbx$/i, '');
    fs.writeFileSync(path.join(MODELS, `${base}.model.gz`), gz);
    const fbxGz = zlib.gzipSync(raw, { level: 9 });
    fs.writeFileSync(src + '.gz', fbxGz);
    console.log(`${name}: ${mb(fbxGz.length)} (.fbx.gz) → ${mb(gz.length)} (.model.gz); ` +
        `reading ${parseMs} ms → ${readMs} ms; ${check.objects} objects match ` +
        `(max position difference ${check.worst.toExponential(1)}, max normal difference ${check.worstNormal.toExponential(1)}` +
        `${check.zeroArea ? `, ${check.zeroArea} corners of zero-area triangles skipped` : ''})`);
}
