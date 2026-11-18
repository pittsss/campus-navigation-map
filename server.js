// Tiny static file server for the campus map (no dependencies).
// Usage:  node server.js   →  http://localhost:3000
// Also saves hand-drawn walking paths (map.html?edit=1 → Save) to paths.json and the route between
// the campuses (map.html?editroute=1 → Save) to campus-route.json — only from this computer.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PATHS_FILE = path.join(ROOT, 'paths.json');
const ROUTE_FILE = path.join(ROOT, 'campus-route.json');   // route between the campuses (map.html?editroute=1)
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
};

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// Saves an edited JSON file (walking paths, or the route between the campuses) — only from this computer.
function saveJson(req, res, file) {
    if (!isLocal(req)) { res.writeHead(403); return res.end('This can only be saved from this computer.'); }
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 10e6) req.destroy();
    });
    req.on('end', () => {
        let data;
        try {
            data = JSON.parse(body);
            if (typeof data !== 'object' || !data || Array.isArray(data)) throw new Error('not an object');
        } catch (err) {
            res.writeHead(400);
            return res.end(`Invalid paths: ${err.message}`);
        }
        // The route file is already laid out one point per line by the page; keep that layout.
        const text = file === ROUTE_FILE ? body : JSON.stringify(data, null, 1);
        fs.writeFile(file, text, err => {
            res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/plain' });
            res.end(err ? `Couldn't save: ${err.message}` : 'saved');
            if (!err) console.log(`Saved ${file}`);
        });
    });
}

http.createServer((req, res) => {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'POST' && urlPath === '/api/paths') return saveJson(req, res, PATHS_FILE);
    if (req.method === 'POST' && urlPath === '/api/campus-route') return saveJson(req, res, ROUTE_FILE);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(ROOT, path.normalize(urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
}).on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${PORT} is already in use — the campus map is probably already running (open http://localhost:${PORT}/map.html).\n` +
        `To restart it, stop the other copy first (Windows: netstat -ano | findstr :${PORT}, then taskkill /PID <number> /F),\n` +
        `or use another port:  set PORT=3001 && pnpm dev`);
    process.exit(1);
}).listen(PORT, () => console.log(`Campus map running at http://localhost:${PORT}`));
