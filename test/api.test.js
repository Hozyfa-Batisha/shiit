// Run with: node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shiit-')), 'shiit.json');
let proc;

async function call(user, method, p, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (user) headers['X-Shiit-User'] = encodeURIComponent(user);
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const texts = (r) => r.body.stack.map((i) => i.text).join(',');

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_FILE: dataFile }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => proc && proc.kill());

test('api needs a name, login creates it', async () => {
  assert.equal((await call(null, 'GET', '/api/state')).status, 401);
  assert.equal((await call(null, 'POST', '/api/login', { name: '<script>' })).status, 400);
  const r = await call(null, 'POST', '/api/login', { name: 'Hozyfa' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'queue');
  assert.equal((await call('Hozyfa', 'GET', '/api/state')).status, 200);
});

test('queue mode is first in, first out: oldest is Now', async () => {
  const U = 'queue-user';
  await call(null, 'POST', '/api/login', { name: U });
  for (const t of ['A', 'B', 'C']) await call(U, 'POST', '/api/ideas', { text: t });
  const s = await call(U, 'GET', '/api/state');
  assert.equal(texts(s), 'A,B,C');
  const done = await call(U, 'POST', `/api/ideas/${s.body.stack[0].id}/done`);
  assert.equal(texts(done), 'B,C');
  assert.equal(done.body.doneToday, 1);
});

test('stack mode is the reverse and protect-focus keeps the top', async () => {
  const U = 'stack-user';
  await call(null, 'POST', '/api/login', { name: U });
  for (const t of ['A', 'B', 'C']) await call(U, 'POST', '/api/ideas', { text: t });
  const flipped = await call(U, 'POST', '/api/settings', { mode: 'stack', protect: false });
  assert.equal(texts(flipped), 'C,B,A');
  assert.equal(texts(await call(U, 'POST', '/api/ideas', { text: 'D' })), 'D,C,B,A');
  await call(U, 'POST', '/api/settings', { protect: true });
  assert.equal(texts(await call(U, 'POST', '/api/ideas', { text: 'E' })), 'D,E,C,B,A');
  assert.equal(texts(await call(U, 'POST', '/api/ideas', { text: 'F' })), 'D,F,E,C,B,A');
  await call(U, 'POST', '/api/settings', { mode: 'queue' });
  assert.equal(texts(await call(U, 'GET', '/api/state')), 'A,B,C,E,F,D');
});

test('top, bury and split behave in both modes', async () => {
  const U = 'moves-user';
  await call(null, 'POST', '/api/login', { name: U });
  for (const t of ['A', 'B', 'C']) await call(U, 'POST', '/api/ideas', { text: t });
  let s = await call(U, 'GET', '/api/state');
  const [a, b, c] = s.body.stack;
  assert.equal(texts(await call(U, 'POST', `/api/ideas/${c.id}/top`)), 'C,A,B');
  assert.equal(texts(await call(U, 'POST', `/api/ideas/${c.id}/bury`)), 'A,B,C');
  const split = await call(U, 'POST', `/api/ideas/${a.id}/split`, { text: 'open the file' });
  assert.equal(texts(split), 'open the file,A,B,C');
  assert.equal(split.body.stack[0].from, 'A');
  assert.ok(split.body.newId);
  await call(U, 'POST', '/api/settings', { mode: 'stack' });
  s = await call(U, 'GET', '/api/state');
  assert.equal(texts(s), 'C,B,A,open the file');
  const split2 = await call(U, 'POST', `/api/ideas/${s.body.stack[0].id}/split`, { text: 'tiny step' });
  assert.equal(texts(split2), 'tiny step,C,B,A,open the file');
  assert.equal(texts(await call(U, 'POST', `/api/ideas/${b.id}/bury`)), 'tiny step,C,A,open the file,B');
  assert.equal(texts(await call(U, 'DELETE', `/api/ideas/${b.id}`)), 'tiny step,C,A,open the file');
});

test('data is separate per name, case-insensitive, and Arabic names work', async () => {
  await call(null, 'POST', '/api/login', { name: 'Sara' });
  await call('Sara', 'POST', '/api/ideas', { text: 'sara idea' });
  const same = await call(null, 'POST', '/api/login', { name: 'sARA' });
  assert.equal(same.body.name, 'Sara');
  assert.equal(texts(same), 'sara idea');
  await call(null, 'POST', '/api/login', { name: 'حذيفة' });
  await call('حذيفة', 'POST', '/api/ideas', { text: 'فكرة' });
  assert.equal(texts(await call('حذيفة', 'GET', '/api/state')), 'فكرة');
  assert.equal(texts(await call('Sara', 'GET', '/api/state')), 'sara idea');
});

test('bad input is rejected and data survives a restart', async () => {
  assert.equal((await call('Hozyfa', 'POST', '/api/ideas', { text: '   ' })).status, 400);
  assert.equal((await call('Hozyfa', 'POST', '/api/ideas/nope/done')).status, 404);
  assert.equal((await call('Hozyfa', 'GET', '/api/xyz')).status, 404);
  assert.equal((await fetch(BASE + '/')).status, 200);
  assert.equal((await fetch(BASE + '/logo.png')).status, 200);
  await call('Hozyfa', 'POST', '/api/ideas', { text: 'persist me' });
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_FILE: dataFile }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.equal(texts(await call('Hozyfa', 'GET', '/api/state')), 'persist me');
});
