// Shiit front end — vanilla JS, no build step.
const $ = (s) => document.querySelector(s);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const NAME_KEY = 'shiit.name';
let me = localStorage.getItem(NAME_KEY) || '';
let state = { name: '', mode: 'queue', protect: true, stack: [], doneToday: 0, streak: 0 };
let timer = null;      // { itemId, minutes, endsAt, finished }
let tick = null;
let stuck = null;      // { id, reason } while the stuck panel is open on the Now item
let stuckDraft = '';   // text typed into the stuck panel, kept across re-renders

const stackEl = $('#stack');
const nodes = new Map(); // item id -> <li>

/* ---------- small helpers ---------- */
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function btn(label, title, cls, onClick) {
  const b = h('button', 'btn' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.floor(m) + 'm ago';
  const hr = m / 60;
  if (hr < 24) return Math.floor(hr) + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, 3500);
}

/* ---------- API ---------- */
async function api(path, method = 'GET', body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (me) headers['X-Shiit-User'] = encodeURIComponent(me); // encoded so Arabic etc. survives the header
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showGate(); throw new Error('login'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------- name screen ---------- */
function showGate(msg) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gateErr').textContent = msg || '';
  $('#nameInput').value = me;
  $('#nameInput').focus();
}
function showApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  $('#text').focus();
}
$('#gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const s = await api('/api/login', 'POST', { name: $('#nameInput').value });
    me = s.name;
    localStorage.setItem(NAME_KEY, me);
    resetView();
    state = s;
    timer = loadTimer();
    render();
    showApp();
    if (timer) runTick();
  } catch (err) {
    $('#gateErr').textContent = err.message;
  }
});
$('#switchUser').addEventListener('click', () => {
  stopTick();
  me = '';
  localStorage.removeItem(NAME_KEY);
  resetView();
  showGate();
});
function resetView() {
  stackEl.replaceChildren();
  nodes.clear();
  stuck = null;
  stuckDraft = '';
  timer = null;
}

/* ---------- timer ---------- */
const timerKey = () => 'shiit.timer.' + me.toLowerCase();
function loadTimer() {
  try { return JSON.parse(localStorage.getItem(timerKey())) || null; } catch { return null; }
}
function saveTimer() {
  if (timer) localStorage.setItem(timerKey(), JSON.stringify(timer)); else localStorage.removeItem(timerKey());
}
function stopTick() {
  clearInterval(tick);
  tick = null;
  document.title = 'Shiit';
}
function startTimer(itemId, minutes) {
  timer = { itemId, minutes, endsAt: Date.now() + minutes * 60_000, finished: false };
  saveTimer();
  runTick();
  render();
}
function clearTimer() {
  timer = null;
  saveTimer();
  stopTick();
  render();
}
const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
function runTick() {
  clearInterval(tick);
  const update = () => {
    if (!timer) return;
    const left = timer.endsAt - Date.now();
    if (left <= 0 && !timer.finished) {
      timer.finished = true;
      saveTimer();
      beep();
      document.title = "⏰ Time's up · Shiit";
      render();
      return;
    }
    if (!timer.finished) {
      const clock = document.querySelector('.timer .clock');
      if (clock) clock.textContent = fmt(left);
      document.title = `${fmt(left)} · Shiit`;
    }
  };
  update();
  tick = setInterval(update, 500);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((d) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + d + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + d);
      o.stop(ctx.currentTime + d + 0.22);
    });
  } catch { /* audio blocked: the tab title still tells you */ }
}

/* ---------- stuck panel ---------- */
const REASONS = [
  ['big', 'Too big'],
  ['start', "Can't start"],
  ['bored', 'Boring'],
  ['need', 'Need something first'],
];
const HINTS = {
  big: { hint: 'Then shrink it. What is the smallest piece you could finish in 5 minutes?', ph: 'Smallest piece…' },
  start: { hint: 'Forget the whole thing. What is the very first physical move? Open the file, find the number, stand up.', ph: 'First move…' },
  bored: { hint: 'Boring is a real problem. Race it: 10 minutes, then you are allowed to quit.', race: 10 },
  need: { hint: 'Then that is the real task. What do you need first?', ph: 'Need…' },
};

function stuckPanel(item) {
  const p = h('div', 'stuck');
  p.append(h('div', 'lbl', "What's the snag?"));

  const chips = h('div', 'chips');
  for (const [key, label] of REASONS) {
    chips.append(btn(label, label, stuck.reason === key ? 'on' : '', () => {
      stuck.reason = key;
      stuckDraft = '';
      render();
      requestAnimationFrame(() => document.querySelector('.stuck input')?.focus());
    }));
  }
  p.append(chips);

  const cfg = HINTS[stuck.reason];
  if (cfg) {
    p.append(h('p', 'hint', cfg.hint));
    if (cfg.ph) {
      const form = h('form');
      form.autocomplete = 'off';
      const input = h('input');
      input.maxLength = 280;
      input.dir = 'auto';
      input.placeholder = cfg.ph;
      input.value = stuckDraft;
      input.setAttribute('aria-label', cfg.ph);
      input.addEventListener('input', () => { stuckDraft = input.value; });
      const go = h('button', 'btn go', 'Make it Now');
      go.type = 'submit';
      form.append(input, go);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        stuck = null;
        stuckDraft = '';
        try {
          const res = await api(`/api/ideas/${item.id}/split`, 'POST', { text });
          state = res;
          render(res.newId);
          toast('Small step is Now. The big one waits right behind it.');
        } catch (err) { toast(err.message); }
      });
      p.append(form);
    }
    if (cfg.race) p.append(btn(`Race it: ${cfg.race} min`, 'Start the timer', 'go', () => startTimer(item.id, cfg.race)));
  }

  p.append(btn('Park it for later', 'Send it to the far end and take the next one', '', () => act(item.id, 'bury')));
  return p;
}

/* ---------- rendering ---------- */
function fillBlock(el, item, idx) {
  const isNow = idx === 0;
  const keep = [...el.classList].filter((c) => c.startsWith('enter-'));
  el.className = 'block' + (isNow ? ' now' : '');
  keep.forEach((c) => el.classList.add(c));
  el.replaceChildren();

  const pos = h('div', 'pos', String(idx + 1).padStart(2, '0'));
  const main = h('div', 'main');

  if (isNow) main.append(h('div', 'tag', 'NOW'));
  if (item.from) main.append(h('div', 'meta', '↳ part of: ' + item.from));
  const text = h('div', 'text', item.text);
  text.dir = 'auto';
  main.append(text);
  main.append(h('div', 'meta', ago(item.createdAt)));

  const actions = h('div', 'actions');
  if (isNow) {
    actions.append(
      btn('Done', 'Finish it (Ctrl+Enter)', 'go', () => complete(item.id)),
      btn(stuck ? 'Close' : 'Stuck?', 'Break it down or get unstuck', stuck ? 'on' : '', () => {
        stuck = stuck ? null : { id: item.id, reason: null };
        stuckDraft = '';
        render();
      }),
    );
  } else {
    actions.append(
      btn('Now', 'Do this one next', '', () => act(item.id, 'top')),
      btn('Done', 'Already finished', '', () => complete(item.id)),
    );
  }
  actions.append(
    btn('Later', state.mode === 'queue' ? 'Back of the line' : 'Bottom of the stack', '', () => act(item.id, 'bury')),
    btn('×', 'Delete', 'kill', () => remove(item.id)),
  );
  main.append(actions);

  if (isNow) {
    const t = h('div', 'timer');
    const mine = timer && timer.itemId === item.id;
    if (mine) {
      if (timer.finished) t.classList.add('finished');
      t.append(
        h('span', 'clock', timer.finished ? 'TIME' : fmt(timer.endsAt - Date.now())),
        btn(timer.finished ? 'Clear' : 'Stop', 'Stop the timer', '', clearTimer),
      );
    } else {
      t.append(h('span', 'lbl', 'Timer'));
      for (const m of [2, 10, 25]) t.append(btn(`${m} min`, `${m} minute focus timer`, '', () => startTimer(item.id, m)));
    }
    main.append(t);
    if (stuck && stuck.id === item.id) main.append(stuckPanel(item));
  }

  el.append(pos, main);
}

function render(newId) {
  // drop state that points at things that no longer exist
  if (timer && !state.stack.some((i) => i.id === timer.itemId)) { timer = null; saveTimer(); stopTick(); }
  if (stuck && state.stack[0]?.id !== stuck.id) stuck = null;

  // FLIP: remember where every block is before we touch the DOM
  const before = new Map();
  for (const [id, el] of nodes) before.set(id, el.getBoundingClientRect().top);

  const ids = new Set(state.stack.map((i) => i.id));
  for (const [id, el] of nodes) if (!ids.has(id)) { el.remove(); nodes.delete(id); }

  state.stack.forEach((item, idx) => {
    let el = nodes.get(item.id);
    if (!el) {
      el = document.createElement('li');
      nodes.set(item.id, el);
      if (item.id === newId && !reduceMotion) {
        const cls = state.mode === 'queue' && idx > 0 ? 'enter-join' : 'enter-drop';
        el.classList.add(cls);
        el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
      }
    }
    fillBlock(el, item, idx);
    stackEl.append(el); // append moves existing nodes into the right order
  });

  if (!reduceMotion) {
    for (const [id, el] of nodes) {
      if (!before.has(id)) continue;
      const delta = before.get(id) - el.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 320, easing: 'cubic-bezier(.2,.8,.3,1)' },
      );
    }
  }

  // chrome around the list
  $('#whoName').textContent = state.name || me;
  $('#doneToday').textContent = state.doneToday;
  $('#streak').textContent = state.streak;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('#protectRow').hidden = state.mode !== 'stack';
  $('#protect').checked = state.protect;
  $('#laneLabel').textContent = state.mode === 'queue' ? 'New ones join the back' : 'New ones land on top';
  $('#laneCount').textContent = state.stack.length ? `${state.stack.length} waiting` : '';
  $('#empty').hidden = state.stack.length > 0;
}

/* ---------- actions ---------- */
async function addIdea(text) {
  const res = await api('/api/ideas', 'POST', { text });
  state = res;
  render(res.newId);
  const pos = state.stack.findIndex((i) => i.id === res.newId) + 1;
  toast(pos === 1 ? "Out of your head. It's Now."
    : state.mode === 'queue' ? `Out of your head. #${pos} in line.` : `Out of your head. #${pos} on the stack.`);
}

async function act(id, action) {
  try { state = await api(`/api/ideas/${id}/${action}`, 'POST'); render(); } catch (e) { toast(e.message); }
}

async function remove(id) {
  try { state = await api(`/api/ideas/${id}`, 'DELETE'); render(); } catch (e) { toast(e.message); }
}

async function complete(id) {
  const el = nodes.get(id);
  if (el && !reduceMotion) {
    const stamp = h('div', 'stamp', 'DONE');
    el.append(stamp);
    await stamp.animate(
      [
        { transform: 'translate(-50%,-50%) rotate(-9deg) scale(2.8)', opacity: 0 },
        { transform: 'translate(-50%,-50%) rotate(-9deg) scale(1)', opacity: 1, offset: 0.3 },
        { transform: 'translate(-50%,-50%) rotate(-9deg) scale(1)', opacity: 1 },
      ],
      { duration: 520, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'forwards' },
    ).finished.catch(() => {});
    await el.animate(
      [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(60px)', opacity: 0 }],
      { duration: 200, easing: 'ease-in', fill: 'forwards' },
    ).finished.catch(() => {});
  }
  try { state = await api(`/api/ideas/${id}/done`, 'POST'); render(); } catch (e) { toast(e.message); render(); }
}

async function setSettings(patch) {
  try { state = await api('/api/settings', 'POST', patch); render(); } catch (e) { toast(e.message); }
}

/* ---------- wiring ---------- */
$('#capture').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.focus(); // cursor stays here so the next thought can go straight in
  try { await addIdea(text); } catch (err) { input.value = text; toast(err.message); }
});

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.mode !== state.mode) setSettings({ mode: b.dataset.mode });
}));
$('#protect').addEventListener('change', (e) => setSettings({ protect: e.target.checked }));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('#app').hidden && state.stack[0]) {
    e.preventDefault();
    complete(state.stack[0].id);
  }
});

// come back to the tab (say you added something on your phone) and it catches up
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || $('#app').hidden || stuck) return;
  try { state = await api('/api/state'); render(); } catch { /* offline or logged out */ }
});

(async function init() {
  if (!me) return showGate();
  try {
    state = await api('/api/state');
    timer = loadTimer();
    render();
    showApp();
    if (timer) runTick();
  } catch (err) {
    if (err.message !== 'login') { showApp(); toast('Cannot reach the server.'); }
  }
})();
