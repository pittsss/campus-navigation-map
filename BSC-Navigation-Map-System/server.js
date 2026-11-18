// Tiny static file server for the campus map
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// On Vercel, write to /tmp since the main filesystem is read-only
const PATHS_FILE = process.env.VERCEL ? path.join('/tmp', 'paths.json') : path.join(ROOT, 'paths.json');

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

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1'].includes(req.socket.remoteAddress) || process.env.VERCEL;

function savePaths(req, res) {
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
        fs.writeFile(PATHS_FILE, JSON.stringify(data, null, 1), err => {
            res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/plain' });
            res.end(err ? `Couldn't save: ${err.message}` : 'saved');
            if (!err) console.log(`Saved walking paths to ${PATHS_FILE}`);
        });
    });
}

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'POST' && urlPath === '/api/paths') return savePaths(req, res);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    
    // If requesting paths.json, check /tmp first if it exists, otherwise root
    let file = path.join(ROOT, path.normalize(urlPath));
    if (urlPath === '/paths.json' && fs.existsSync(PATHS_FILE)) {
        file = PATHS_FILE;
    }

    if (!file.startsWith(ROOT) && !file.startsWith('/tmp')) { 
        res.writeHead(403); 
        return res.end('Forbidden'); 
    }

    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
});

// Only listen locally; export server for Vercel serverless function
if (!process.env.VERCEL) {
    server.listen(PORT, () => console.log(`Campus map running at http://localhost:${PORT}`));
}

module.exports = server;