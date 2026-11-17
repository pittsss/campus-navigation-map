// Makes compressed copies of the 3D models (models/*.fbx → models/*.fbx.gz) for faster loading.
// The map loads the .gz files and unpacks them in the browser. Run again whenever a model changes:
//   node tools/compress-models.mjs
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
for (const name of fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.fbx'))) {
    const src = path.join(dir, name);
    const out = zlib.gzipSync(fs.readFileSync(src), { level: 9 });
    fs.writeFileSync(src + '.gz', out);
    const mb = n => (n / 1048576).toFixed(1) + ' MB';
    console.log(`${name}: ${mb(fs.statSync(src).size)} → ${mb(out.length)}`);
}
