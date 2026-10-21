// Shiit — zero-dependency Node server. One JSON file holds every user's data.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'shiit.json');
const PUB = path.join(__dirname, 'public');
const MAX_LEN = 280;
const MAX_DONE_KEPT = 1000;
const MAX_ITEMS = 1000;
const MAX_USERS = Number(process.env.MAX_USERS) || 200;

fs.mkdirSync(path.dirname(DATA), { recursive: true });

/* ---------- storage ---------- */
// users: Map<lowercased name, { name, created, mode, protect, items[], done[] }>
let users = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  if (raw && raw.users) users = new Map(Object.entries(raw.users));
  else if (raw && Array.isArray(raw.stack) && raw.stack.length) fs.copyFileSync(DATA, DATA + '.v1.bak'); // pre-users format: keep a copy
} catch { /* first run */ }

function save() {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, users: Object.fromEntries(users) }));
  fs.renameSync(tmp, DATA); // atomic swap so a crash never corrupts the file
}

/* ---------- users ---------- */
function cleanName(raw) {
  const n = String(raw || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{N}_ .\-]{1,32}$/u.test(n) ? n : null;
}
const keyOf = (name) => name.toLowerCase();

function userFrom(req) {
  let raw = req.headers['x-shiit-user'];
  if (!raw) return null;
  try { raw = decodeURIComponent(raw); } catch { return null; }
  const n = cleanName(raw);
  return n ? users.get(keyOf(n)) || null : null;
}

/* ---------- ordering ----------
   Every item has a numeric rank. QUEUE order is rank ascending (lowest = Now, oldest first).
   STACK order is the exact reverse (highest = Now, newest first). The server always returns
   the list already in the user's mode, so index 0 is the item to work on. */
const ranks = (u) => u.items.map((x) => x.rank);
const minRank = (u) => (u.items.length ? Math.min(...ranks(u)) : 0);
const maxRank = (u) => (u.items.length ? Math.max(...ranks(u)) : 0);

// where "Now" sits / where "the far end" sits, for the user's current mode
const nowRank = (u) => (u.mode === 'queue' ? minRank(u) - 1 : maxRank(u) + 1);
const farRank = (u) => (u.mode === 'queue' ? maxRank(u) + 1 : minRank(u) - 1);

// stack mode + "protect focus": land directly under the current top
function belowTopRank(u) {
  const rs = ranks(u).sort((a, b) => a - b);
  const n = rs.length;
  return n >= 2 ? (rs[n - 1] + rs[n - 2]) / 2 : rs[0] - 1;
}

function normalize(u) {
  u.items.sort((a, b) => a.rank - b.rank);
  u.items.forEach((x, i) => { x.rank = i; });
}

/* ---------- stats / view ---------- */
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

function stats(u) {
  const days = new Set(u.done.map((d) => dayKey(d.doneAt)));
  const todayKey = dayKey(Date.now());
  let streak = 0;
  let t = Date.now();
  if (!days.has(todayKey)) t -= 864e5; // a streak survives until the day ends
  while (days.has(dayKey(t))) { streak++; t -= 864e5; }
  return { doneToday: u.done.filter((d) => dayKey(d.doneAt) === todayKey).length, streak };
}

function view(u) {
  const items = [...u.items].sort((a, b) => a.rank - b.rank);
  if (u.mode === 'stack') items.reverse();
  return { name: u.name, mode: u.mode, protect: u.protect, stack: items, ...stats(u) };
}

/* ---------- http helpers ---------- */
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 10_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const cleanText = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, MAX_LEN);

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

  try {
    // identify yourself with just a name (no password: it is a label, not a lock)
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req);
      const name = cleanName(body.name);
      if (!name) return send(res, 400, { error: 'Use letters, numbers, spaces, - _ . (max 32 characters)' });
      let u = users.get(keyOf(name));
      if (!u) {
        if (users.size >= MAX_USERS) return send(res, 429, { error: 'This Shiit is full of people' });
        u = { name, created: Date.now(), mode: 'queue', protect: true, items: [], done: [] };
        users.set(keyOf(name), u);
        save();
      }
      return send(res, 200, view(u));
    }

    const u = userFrom(req);
    if (!u) return send(res, 401, { error: 'login' });

    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, view(u));

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      if (body.mode === 'queue' || body.mode === 'stack') u.mode = body.mode;
      if (typeof body.protect === 'boolean') u.protect = body.protect;
      save();
      return send(res, 200, view(u));
    }

    if (req.method === 'POST' && url.pathname === '/api/ideas') {
      const body = await readBody(req);
      const text = cleanText(body.text);
      if (!text) return send(res, 400, { error: 'empty' });
      if (u.items.length >= MAX_ITEMS) return send(res, 400, { error: 'Too many open ideas. Finish or delete a few.' });
      let rank;
      if (u.mode === 'queue') rank = farRank(u); // joins the back of the line
      else rank = u.protect && u.items.length ? belowTopRank(u) : nowRank(u); // lands on top, or under the top if protecting focus
      const idea = { id: crypto.randomUUID(), text, createdAt: Date.now(), rank };
      u.items.push(idea);
      normalize(u);
      save();
      return send(res, 201, { ...view(u), newId: idea.id });
    }

    const m = url.pathname.match(/^\/api\/ideas\/([\w-]+)(?:\/(done|top|bury|split))?$/);
    if (m) {
      const [, id, action] = m;
      const i = u.items.findIndex((x) => x.id === id);
      if (i === -1) return send(res, 404, { error: 'not found' });
      const item = u.items[i];
      let newId;

      if (req.method === 'DELETE' && !action) {
        u.items.splice(i, 1);
      } else if (req.method === 'POST' && action === 'split') {
        // "I'm stuck": a smaller first step takes the Now spot, the original waits right behind it
        const body = await readBody(req);
        const text = cleanText(body.text);
        if (!text) return send(res, 400, { error: 'empty' });
        if (u.items.length >= MAX_ITEMS) return send(res, 400, { error: 'Too many open ideas.' });
        const step = { id: crypto.randomUUID(), text, from: item.text.slice(0, 120), createdAt: Date.now(), rank: nowRank(u) };
        u.items.push(step);
        newId = step.id;
      } else if (req.method === 'POST' && action) {
        u.items.splice(i, 1);
        if (action === 'done') {
          u.done.push({ ...item, doneAt: Date.now() });
          if (u.done.length > MAX_DONE_KEPT) u.done = u.done.slice(-MAX_DONE_KEPT);
        } else if (action === 'top') {
          item.rank = nowRank(u);
          u.items.push(item);
        } else if (action === 'bury') {
          item.rank = farRank(u);
          u.items.push(item);
        }
      } else {
        return send(res, 405, { error: 'method' });
      }

      normalize(u);
      save();
      return send(res, 200, newId ? { ...view(u), newId } : view(u));
    }

    return send(res, 404, { error: 'unknown route' });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Shiit listening on :${PORT}, data at ${DATA}`));
