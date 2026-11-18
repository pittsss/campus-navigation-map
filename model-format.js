// Reader for the map's compact 3D model files (models/*.model.gz, made by tools/build-models.mjs).
// They hold exactly what FBXLoader builds from the .fbx files (object tree, names, materials, triangles),
// minus what the map never uses (texture coordinates, FBX metadata), in a binary layout that is several
// times smaller to download and far quicker to read than the text .fbx files.
//
// File layout (before gzip):  "CMB1" | u32 JSON length | JSON | padding to 4 bytes | binary data
// JSON: { version, materials: [Material.toJSON()], geometries: [...], root: node }
//   geometry: { n: vertex count, i: index count, i32: bool, pos, idx, nrm (byte offsets; nrm null = flat),
//               groups: [[start, count, materialIndex]] }
//   node: { n: name, t: 'G' | 'M', p: [x,y,z], q: [x,y,z,w], s: [x,y,z], g: geometry, m: material(s), c: [children] }
// Positions are float32; indices are delta-coded (each = previous + stored), which compresses much better.
// Normals: null when every face is flat (worked out again here), else int8 per vertex.
import * as THREE from 'three';

export const MODEL_MAGIC = 'CMB1';

export function parseModel(buffer) {
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== MODEL_MAGIC) throw new Error('not a campus model file');
    const jsonLen = new DataView(buffer).getUint32(4, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen)));
    const base = 8 + jsonLen + ((4 - ((8 + jsonLen) % 4)) % 4);

    const matLoader = new THREE.MaterialLoader();
    const materials = json.materials.map(m => {
        const mat = matLoader.parse(m);
        for (const [k, rgb] of Object.entries(m.exact || {})) mat[k].fromArray(rgb);   // full-precision colours
        return mat;
    });

    const geometries = json.geometries.map(g => {
        const pos = new Float32Array(buffer, base + g.pos, g.n * 3);
        const idx = g.i32 ? new Int32Array(buffer, base + g.idx, g.i) : new Int16Array(buffer, base + g.idx, g.i);
        // Undo the delta coding while expanding to one vertex per triangle corner (like FBXLoader's output).
        const out = new Float32Array(g.i * 3);
        let v = 0;
        for (let k = 0; k < g.i; k++) {
            v = g.i32 ? v + idx[k] : (v + idx[k]) & 0xffff;
            out[k * 3] = pos[v * 3];
            out[k * 3 + 1] = pos[v * 3 + 1];
            out[k * 3 + 2] = pos[v * 3 + 2];
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
        if (g.nrm === null) {
            geo.computeVertexNormals();   // non-indexed → flat face normals, same as the originals
        } else {
            const q = new Int8Array(buffer, base + g.nrm, g.i * 3);
            const nrm = new Float32Array(g.i * 3);
            for (let k = 0; k < nrm.length; k += 3) {
                const x = q[k] / 127, y = q[k + 1] / 127, z = q[k + 2] / 127;
                const l = Math.hypot(x, y, z) || 1;
                nrm[k] = x / l; nrm[k + 1] = y / l; nrm[k + 2] = z / l;
            }
            geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        }
        for (const [start, count, mi] of g.groups) geo.addGroup(start, count, mi);
        return geo;
    });

    const build = node => {
        const o = node.t === 'M'
            ? new THREE.Mesh(geometries[node.g], Array.isArray(node.m) ? node.m.map(i => materials[i]) : materials[node.m])
            : new THREE.Group();
        o.name = node.n || '';
        if (node.p) o.position.fromArray(node.p);
        if (node.q) o.quaternion.fromArray(node.q);
        if (node.s) o.scale.fromArray(node.s);
        if (node.c) for (const c of node.c) o.add(build(c));
        return o;
    };
    return build(json.root);
}
