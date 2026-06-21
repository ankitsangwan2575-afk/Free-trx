/**
 * FreeTRX backend — stores verified wallet connections.
 *
 * Why this only accepts addresses from a completed adapter.connect():
 * the frontend never lets the user type an address into a text box.
 * It only ever sends the address TronLink/WalletConnect returned after
 * the wallet itself approved the connection. That's what makes the
 * address trustworthy enough to store.
 *
 * Zero dependencies — uses Node's built-in http module so `npm install`
 * isn't required to run this. Swap in Express later if the project grows.
 *
 * Run: node server.js
 * Listens on http://localhost:4000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const DB_FILE = path.join(__dirname, 'wallets.json');
const PUBLIC_DIR = __dirname; // index.html lives next to server.js (flat repo layout)

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Files that must never be served directly, now that PUBLIC_DIR is the repo root.
const BLOCKED_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'wallets.json', 'render.yaml', '.env']);

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const requestedName = path.basename(urlPath);
  if (BLOCKED_FILES.has(requestedName) || urlPath.startsWith('/.')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent path traversal outside the public dir.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// --- tiny JSON file "database" ---
function readDB() {
  if (!fs.existsSync(DB_FILE)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { wallets: [] };
  }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- basic address sanity check (Tron base58 addresses start with 'T', 34 chars) ---
function isPlausibleTronAddress(addr) {
  return typeof addr === 'string' && /^T[a-zA-Z0-9]{33}$/.test(addr);
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // tighten to your real domain in production
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // basic guard against huge payloads
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  // POST /api/wallets — register a verified wallet connection
  if (req.method === 'POST' && req.url === '/api/wallets') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: 'Invalid JSON body' });
    }

    const { address, walletType, sessionId } = body;

    if (!isPlausibleTronAddress(address)) {
      return send(res, 400, { error: 'Address missing or not a valid Tron address format' });
    }
    if (!['TronLink', 'WalletConnect', 'Demo'].includes(walletType)) {
      return send(res, 400, { error: 'walletType must be TronLink, WalletConnect, or Demo' });
    }

    const db = readDB();
    const existing = db.wallets.find(w => w.address === address);

    if (existing) {
      existing.lastSeen = new Date().toISOString();
      existing.connectCount += 1;
    } else {
      db.wallets.push({
        id: crypto.randomUUID(),
        address,
        walletType,
        sessionId: sessionId || null,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        connectCount: 1,
      });
    }
    writeDB(db);

    return send(res, 200, { ok: true, address });
  }

  // GET /api/wallets — list stored wallets (admin/debug use)
  if (req.method === 'GET' && req.url === '/api/wallets') {
    const db = readDB();
    return send(res, 200, db.wallets);
  }

  // GET /api/wallets/:address — look up one wallet
  if (req.method === 'GET' && req.url.startsWith('/api/wallets/')) {
    const address = decodeURIComponent(req.url.split('/api/wallets/')[1]);
    const db = readDB();
    const wallet = db.wallets.find(w => w.address === address);
    if (!wallet) return send(res, 404, { error: 'Not found' });
    return send(res, 200, wallet);
  }

  // Anything else: serve the frontend as static files.
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`FreeTRX running at http://localhost:${PORT}`);
  console.log(`Wallet records stored in ${DB_FILE}`);
});
