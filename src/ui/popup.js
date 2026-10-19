export {};
/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => { if (r?.error) throw new Error(r.error); return r; });

let plan = null;
const VIA = {
  opener: 'opened from', history: 'usually opened from', link: 'linked from', path: 'under',
  list: 'from list', adjacent: 'next to', transient: 'sign-in/redirect', variant: 'another version of',
};

function status(text, isError = false) {
  $('status').textContent = text;
  $('status').style.color = isError ? 'var(--coral-ink)' : '';
}

function confChip(c, threshold) {
  const span = document.createElement('span');
  span.className = 'chip ' + (c >= threshold ? 'sure' : c >= 0.6 ? 'likely' : 'maybe');
  span.textContent = c >= threshold ? 'Safe' : c >= 0.6 ? 'Likely' : 'Maybe';
  span.title = `Confidence ${Math.round(c * 100)}%`;
  return span;
}

function row({ checked, ids, tab, sub, badges = [] }) {
  const li = document.createElement('li');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = checked; cb.dataset.ids = ids.join(',');
  cb.setAttribute('aria-label', `Close ${tab.title}`);
  const fav = document.createElement('img');
  fav.className = 'fav'; fav.alt = '';
  if (tab.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl)) fav.src = tab.favIconUrl;
  const txt = document.createElement('div'); txt.className = 'txt';
  const title = document.createElement('button');
  title.className = 'title'; title.textContent = tab.title || tab.url; title.title = tab.url;
  title.onclick = () => send({ type: 'focus', tabId: tab.id, windowId: tab.windowId });
  const s = document.createElement('div'); s.className = 'sub'; s.textContent = sub;
  txt.append(title, s);
  const b = document.createElement('div'); b.className = 'badges'; b.append(...badges);
  li.append(cb, fav, txt, b);
  return li;
}

function render() {
  const p = plan;
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  $('stats').textContent = `${pl(p.stats.tabs, 'tab')} in ${pl(p.stats.windows, 'window')}, ${pl(p.stats.groups, 'group')}`;
  $('keyBanner').hidden = p.hasKey;
  $('jevError').hidden = !p.jevError;
  $('jevError').textContent = p.jevError ? `Jev couldn't review child tabs: ${p.jevError}` : '';
  $('undo').hidden = !p.canUndo;

  const dl = $('dupList'); dl.replaceChildren();
  for (const d of p.duplicates) {
    const n = d.close.length;
    dl.append(row({
      checked: true, ids: d.close.map((t) => t.id), tab: d.close[0],
      sub: `${n + 1} copies, keeps 1 and closes ${n}`, badges: [chip(`×${n + 1}`)],
    }));
  }
  $('dupSection').hidden = !p.duplicates.length;
  $('dupCount').textContent = p.duplicates.reduce((a, d) => a + d.close.length, 0) || '';

  const kl = $('kidList'); kl.replaceChildren();
  for (const c of p.children) {
    const rel = c.parent ? `${VIA[c.via] || 'from'} “${trim(c.parent.title, 38)}”` : (VIA[c.via] || '');
    const badges = [confChip(c.confidence, p.autoCloseConfidence)];
    if (c.jev != null) { const j = chip(`Jev ${Math.round(c.jev * 100)}%`); j.title = 'Jev’s probability this tab is safe to close'; badges.push(j); }
    kl.append(row({ checked: c.confidence >= p.autoCloseConfidence, ids: [c.tab.id], tab: c.tab, sub: `${rel}, idle ${c.idle}`, badges }));
  }
  $('kidSection').hidden = !p.children.length;
  $('kidCount').textContent = p.children.length || '';
  $('kidAll').checked = p.children.length > 0 && p.children.every((c) => c.confidence >= p.autoCloseConfidence);
  $('empty').hidden = !!(p.duplicates.length || p.children.length);
  const nClean = p.duplicates.reduce((a, d) => a + d.close.length, 0) + p.children.length;
  $('nCleanup').textContent = nClean || '';
  syncButtons();
}

function chip(text) { const s = document.createElement('span'); s.className = 'chip'; s.textContent = text; return s; }
function trim(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function selectedIds() {
  return [...document.querySelectorAll('#lists li input:checked')].flatMap((cb) => cb.getAttribute('data-ids').split(',').map(Number));
}

function syncButtons() {
  const n = selectedIds().length;
  $('closeSel').disabled = !n;
  $('closeSel').textContent = n ? `Close ${n}` : 'Close selected';
}

async function load() {
  status('');
  try {
    plan = await send({ type: 'plan' });
    render();
    syncRegroupCopy();
  } catch (e) {
    status(e.message, true);
  }
}

async function busy(btn, label, fn) {
  const all = document.querySelectorAll('button');
  all.forEach((b) => (b.disabled = true));
  const old = btn.textContent;
  btn.textContent = label;
  btn.classList.add('working');
  try { await fn(); } catch (e) { status(e.message, true); }
  finally { btn.classList.remove('working'); btn.textContent = old; all.forEach((b) => (b.disabled = false)); syncButtons(); }
}

$('lists').addEventListener('change', (/** @type {any} */ e) => {
  if (e.target.id === 'dupAll') $('dupList').querySelectorAll('input').forEach((c) => (c.checked = e.target.checked));
  if (e.target.id === 'kidAll') $('kidList').querySelectorAll('input').forEach((c) => (c.checked = e.target.checked));
  syncButtons();
});

$('closeSel').onclick = () => busy($('closeSel'), 'Closing…', async () => {
  const r = await send({ type: 'close', tabIds: selectedIds() });
  await load();
  status(`Closed ${r.closed} tab${r.closed === 1 ? '' : 's'}.`);
});

$('group').onclick = () => busy($('group'), 'Grouping…', async () => {
  const r = await send({ type: 'group' });
  await load();
  const how = r.mode === 'goals' ? (r.via === 'jev' ? 'by goal, checked by Jev' : 'by goal') : (r.via === 'jev' ? 'with Jev' : 'by use case');
  status(r.groups.length ? `Grouped ${how}: ${[...new Set(r.groups.map((g) => g.name))].join(', ')}` : 'No groups worth making yet.');
  if (r.error) status(`Jev failed (${r.error}); grouped without it.`, true);
});

$('reorder').onclick = () => busy($('reorder'), 'Ordering…', async () => {
  const r = await send({ type: 'reorder' });
  status(r.moved ? 'Most-used tabs are now on the left.' : 'Already in usage order.');
});

$('tidy').onclick = () => busy($('tidy'), 'Tidying…', async () => {
  const r = await send({ type: 'tidy', closeIds: selectedIds(), steps: { dedupe: false, children: false, group: true, reorder: true } });
  await load();
  const bits = [];
  if (r.closed) bits.push(`closed ${r.closed}`);
  if (r.groups.length) bits.push(`${new Set(r.groups.map((g) => g.name)).size} groups`);
  if (r.moved) bits.push('reordered');
  status(bits.length ? `Done: ${bits.join(', ')}.` : 'Already tidy.');
  if (r.errors?.length) status(r.errors[0], true);
});

$('undo').onclick = () => busy($('undo'), 'Reopening…', async () => {
  const r = await send({ type: 'undo' });
  await load();
  status(`Reopened ${r.reopened} tab${r.reopened === 1 ? '' : 's'}.`);
});

$('settings').onclick = $('openSettings').onclick = () => chrome.runtime.openOptionsPage();

// ---------------------------------------------------------------- regroup (one-time rebuild)

const modeLabel = () => (plan?.groupingMode === 'useCases' ? 'by use case' : 'by goal');
function syncRegroupCopy() {
  $('regroupBtn').textContent = `Regroup everything ${modeLabel()}`;
  $('regroupAsk').textContent = `Ungroup Tab Land's groups and rebuild them ${modeLabel()}? Your own groups stay.`;
}
$('regroupBtn').onclick = () => { syncRegroupCopy(); $('regroupBtn').hidden = true; $('regroupConfirm').hidden = false; $('regroupYes').focus(); };
$('regroupNo').onclick = () => { $('regroupConfirm').hidden = true; $('regroupBtn').hidden = false; };
$('regroupYes').onclick = () => busy($('regroupYes'), 'Regrouping…', async () => {
  const r = await send({ type: 'regroup' });
  $('regroupConfirm').hidden = true; $('regroupBtn').hidden = false;
  await load();
  await syncUndoRegroup();
  const names = [...new Set(r.groups.map((g) => g.name))];
  status(names.length ? `Regrouped ${modeLabel()}: ${names.join(', ')}` : `Ungrouped ${r.regrouped} group${r.regrouped === 1 ? '' : 's'}; nothing to regroup yet.`);
  if (r.error) status(`Jev failed (${r.error}); regrouped without it.`, true);
});
async function syncUndoRegroup() {
  const st = await send({ type: 'regroupState' }).catch(() => null);
  $('undoRegroup').hidden = !st?.canUndo;
}
$('undoRegroup').onclick = () => busy($('undoRegroup'), 'Restoring…', async () => {
  const r = await send({ type: 'undoRegroup' });
  await load();
  await syncUndoRegroup();
  status(`Restored ${r.restored} group${r.restored === 1 ? '' : 's'}.`);
});
syncUndoRegroup();

load();

// ---------------------------------------------------------------- palette

const q = $('q');
let results = [];
let sel = 0;
let seq = 0;
let timer = null;
const KIND = { tab: 'Open tabs', closed: 'Recently closed', history: 'History' };
const ACTION = { tab: 'Switch', closed: 'Reopen', history: 'Open' };
$('qHint').textContent = /Mac/.test(navigator.platform) ? '⌘⇧K' : 'Ctrl+Shift+K';

function where(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : ''); } catch { return url; }
}

async function runSearch() {
  const text = q.value.trim();
  const mine = ++seq;
  if (!text) { $('results').hidden = true; $('home').hidden = false; return; }
  try {
    const r = await send({ type: 'search', q: text });
    if (mine !== seq) return;
    results = r;
    sel = 0;
    renderResults();
  } catch (e) { status(e.message, true); }
}

function renderResults() {
  $('home').hidden = true;
  $('results').hidden = false;
  const ul = $('resultList');
  ul.replaceChildren();
  let lastKind = null;
  results.forEach((r, i) => {
    if (r.kind !== lastKind) {
      const h = document.createElement('li'); h.className = 'sec'; h.setAttribute('role', 'presentation'); h.textContent = KIND[r.kind];
      ul.append(h); lastKind = r.kind;
    }
    const li = document.createElement('li');
    li.className = 'res'; li.setAttribute('role', 'option'); li.id = `r${i}`;
    li.setAttribute('aria-selected', String(i === sel));
    const fav = document.createElement('img'); fav.className = 'fav'; fav.alt = '';
    if (r.favIconUrl && /^https?:|^data:/.test(r.favIconUrl)) fav.src = r.favIconUrl;
    const txt = document.createElement('div'); txt.className = 'txt';
    const t = document.createElement('div'); t.className = 'title'; t.textContent = r.title || r.url;
    const s = document.createElement('div'); s.className = 'sub'; s.textContent = where(r.url);
    txt.append(t, s);
    const k = document.createElement('span'); k.className = 'kind'; k.textContent = i === sel ? `${ACTION[r.kind]} ↵` : '';
    li.append(fav, txt, k);
    li.onmouseenter = () => { if (sel !== i) { sel = i; renderResults(); } };
    li.onclick = () => openResult(i);
    ul.append(li);
  });
  $('noResults').hidden = results.length > 0;
  q.setAttribute('aria-activedescendant', results.length ? `r${sel}` : '');
  document.getElementById(`r${sel}`)?.scrollIntoView({ block: 'nearest' });
}

async function openResult(i) {
  const r = results[i];
  if (!r) return;
  await send({ type: 'open', result: r });
  window.close();
}

q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 60); });
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && results.length) { sel = (sel + 1) % results.length; renderResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && results.length) { sel = (sel - 1 + results.length) % results.length; renderResults(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); openResult(sel); }
  else if (e.key === 'Escape' && q.value) { e.preventDefault(); q.value = ''; runSearch(); }
});
q.addEventListener('input', () => {
  // ">" switches to Ask, carrying whatever follows.
  if (q.value.startsWith('>')) { const rest = q.value.slice(1).trimStart(); q.value = ''; runSearch(); setMode('ask'); askInput.value = rest; syncSend(); }
});
q.focus();

// ---------------------------------------------------------------- views + contexts

const GROUP_HEX = { grey: '#8a8f98', blue: '#5e8bff', red: '#ff6b7a', yellow: '#f2b705', green: '#34c27a', pink: '#ec5fb0', purple: '#9b7bff', cyan: '#22b8cf', orange: '#ff9548' };
const VIEWS = { cleanup: 'viewCleanup', contexts: 'viewContexts', later: 'viewLater' };

function showView(v) {
  for (const b of document.querySelectorAll('.seg:not(.mode) button')) b.setAttribute('aria-selected', String(b.getAttribute('data-view') === v));
  for (const [k, id] of Object.entries(VIEWS)) { const el = $(id); if (el) el.hidden = k !== v; }
  if (v === 'contexts') loadContexts();
}
document.querySelector('.seg:not(.mode)').addEventListener('click', (/** @type {any} */ e) => { const b = e.target.closest('button[data-view]'); if (b) showView(b.getAttribute('data-view')); });

function ago(t) {
  const m = (Date.now() - t) / 60e3;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function ctxRow({ color, name, sub, buttons }) {
  const li = document.createElement('li'); li.className = 'ctx';
  const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = GROUP_HEX[color] || GROUP_HEX.grey;
  const txt = document.createElement('div'); txt.className = 'txt';
  const t = document.createElement('div'); t.className = 'title'; t.textContent = name;
  const s = document.createElement('div'); s.className = 'sub'; s.textContent = sub;
  txt.append(t, s);
  const acts = document.createElement('div'); acts.className = 'acts';
  for (const [label, cls, fn] of buttons) {
    const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label;
    b.onclick = () => busy(b, '…', fn);
    acts.append(b);
  }
  li.append(dot, txt, acts);
  return li;
}

async function loadContexts() {
  const c = await send({ type: 'contexts' });
  const plural = (n) => `${n} tab${n === 1 ? '' : 's'}`;
  $('openCtx').replaceChildren(...c.open.map((g) => ctxRow({
    color: g.color, name: g.name, sub: `${plural(g.count)}: ${g.preview.join(', ')}`,
    buttons: [['Park', '', async () => { const r = await send({ type: 'park', groupId: g.groupId }); status(`Parked ${r.name} (${plural(r.parked)}).`); await loadContexts(); }]],
  })));
  $('parkedCtx').replaceChildren(...c.parked.map((p) => ctxRow({
    color: p.color, name: p.name, sub: `${plural(p.count)}, parked ${ago(p.parkedAt)}`,
    buttons: [
      ['Resume', '', async () => { const r = await send({ type: 'resume', id: p.id }); status(`Resumed ${r.name}.`); await loadContexts(); }],
      ['✕', 'ghost', async () => { await send({ type: 'dropContext', id: p.id }); await loadContexts(); }],
    ],
  })));
  $('openCtxEmpty').hidden = c.open.length > 0;
  $('parkedCtxEmpty').hidden = c.parked.length > 0;
  $('nContexts').textContent = c.parked.length || '';
}
send({ type: 'contexts' }).then((c) => { $('nContexts').textContent = c.parked.length || ''; }).catch(() => {});

// ---------------------------------------------------------------- Ask: move and merge by saying so

const askInput = $('askInput');
const thread = $('askThread');
let askBusy = false;
const svgOk = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function setMode(m) {
  for (const b of document.querySelectorAll('.seg.mode button')) b.setAttribute('aria-selected', String(b.getAttribute('data-mode') === m));
  $('searchMode').hidden = m !== 'search';
  $('askMode').hidden = m !== 'ask';
  document.body.classList.toggle('asking', m === 'ask');
  if (m === 'ask') { loadAskHome(); askInput.focus(); } else q.focus();
}
document.querySelector('.seg.mode').addEventListener('click', (/** @type {any} */ e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.getAttribute('data-mode')); });

function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
function dot(color) { const d = el('span', 'dot'); d.style.background = GROUP_HEX[color] || color || GROUP_HEX.grey; return d; }
function scrollDown() { thread.scrollTop = thread.scrollHeight; }
function say(text, { ok = false, thinking = false } = {}) {
  const b = el('div', 'bot' + (thinking ? ' thinking' : ''));
  if (ok) { const i = el('span', 'ok'); i.innerHTML = svgOk; b.append(i); }
  b.append(el('div', '', text));
  thread.append(b); scrollDown();
  return b;
}
function syncSend() { $('askSend').disabled = askBusy || !askInput.value.trim(); }

async function loadAskHome() {
  try {
    const h = await send({ type: 'askHome' });
    const ul = $('lookAlikes'); ul.replaceChildren();
    for (const p of h.lookAlikes) {
      const li = document.createElement('li');
      const what = el('span', 'what');
      what.append(el('b', '', p.from.title), ' ', el('span', 'n', String(p.from.count)), ' into ', el('b', '', p.into.title), ' ', el('span', 'n', String(p.into.count)));
      const go = el('button', 'link', 'Merge');
      go.onclick = () => ask(`Merge ${p.from.title} into ${p.into.title}`);
      li.append(dot(p.into.color), what, go);
      ul.append(li);
    }
    $('lookAlikeSec').hidden = !h.lookAlikes.length;
    $('askToast').hidden = !h.canUndo || !$('askToastText').textContent;
  } catch (e) { status(e.message, true); }
}

for (const b of document.querySelectorAll('.try')) b.addEventListener('click', () => { askInput.value = b.getAttribute('data-text') || ''; askInput.focus(); syncSend(); });
askInput.addEventListener('input', syncSend);
askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('askForm').requestSubmit(); } });
$('askForm').addEventListener('submit', (e) => { e.preventDefault(); const t = askInput.value.trim(); if (t && !askBusy) ask(t); });

async function call(msg) {
  askBusy = true; syncSend();
  const wait = say('Working on it…', { thinking: true });
  try { return await send(msg); }
  catch (e) { say(`Something went wrong: ${e.message}`); return null; }
  finally { wait.remove(); askBusy = false; syncSend(); }
}

async function ask(text) {
  $('askIntro').hidden = true;
  thread.append(el('div', 'me', text)); scrollDown();
  askInput.value = ''; syncSend();
  const r = await call({ type: 'ask', text });
  if (r) handle(r);
}

function handle(r) {
  if (r.error) say(`Jev couldn't help this time (${r.error}), so I matched on words.`);
  if (r.reply) return say(r.reply);
  if (r.done) return done(r.done);
  if (r.questions) return askQuestions(r.session, r.questions);
  if (r.preview) return showPreview(r.session, r.preview);
}

function done(d) {
  say(d.message, { ok: true });
  $('askToastText').textContent = d.message;
  $('askToast').hidden = false;
  load();
}

function askQuestions(session, questions) {
  const answers = {};
  say(session.sure.length ? `${session.sure.length} tab${session.sure.length === 1 ? '' : 's'} clearly fit. A few I'm not sure about:` : 'I need to check a few things first:');
  const cards = questions.map((qq, i) => {
    const c = el('div', 'card' + (i === 0 ? ' active' : ''));
    c.append(el('div', 'q', qq.text));
    if (qq.samples?.length) {
      const sm = el('div', 'samples');
      for (const t of qq.samples) sm.append(el('div', '', t));
      if (qq.more) sm.append(el('div', 'muted', `and ${qq.more} more`));
      c.append(sm);
    }
    const opts = el('div', 'opts');
    for (const o of qq.options) {
      const b = el('button', 'btn', o.label);
      b.onclick = async () => {
        answers[qq.id] = o.value;
        opts.querySelectorAll('button').forEach((x) => x.classList.toggle('picked', x === b));
        c.classList.remove('active');
        const next = cards.find((x, k) => !(questions[k].id in answers));
        if (next) { next.classList.add('active'); next.scrollIntoView({ block: 'nearest' }); return; }
        const r = await call({ type: 'askAnswer', session, answers });
        if (r) handle(r);
      };
      opts.append(b);
    }
    c.append(opts);
    thread.append(c);
    return c;
  });
  scrollDown();
}

function showPreview(session, pv) {
  const c = el('div', 'card active');
  const hd = el('div', 'pv-hd');
  if (pv.target) {
    hd.append(dot(pv.target.color), el('span', '', pv.target.name), el('span', 'muted', pv.target.isNew ? 'new group' : `${pv.target.count} → ${pv.target.count + pv.total} tabs`));
  } else hd.append(el('span', '', 'Take out of the group'), el('span', 'muted', `${pv.tabs.length} tabs`));
  c.append(hd);
  for (const m of pv.merging) c.append(el('div', 'pv-merge', `${m.title} merges in · ${m.count} tab${m.count === 1 ? '' : 's'}, group closes`));
  const list = el('ul', 'pv-list');
  const sections = [['fit', pv.fromGroups > 1 ? `Moving in from ${pv.fromGroups} groups` : 'Fit what you asked'], ['yes', 'You said yes']];
  for (const [key, label] of sections) {
    const rows = pv.tabs.filter((t) => t.section === key);
    if (!rows.length) continue;
    list.append(Object.assign(el('li', 'pv-sec', `${label} · ${rows.length}`), { role: 'presentation' }));
    for (const t of rows) {
      const li = document.createElement('li');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.id = String(t.id); cb.setAttribute('aria-label', `Move ${t.title}`);
      const fav = el('img', 'fav'); fav.alt = ''; if (/^https?:|^data:/.test(t.favIconUrl)) fav.src = t.favIconUrl;
      const ti = el('div', 'title', t.title);
      li.append(cb, fav, ti, t.p != null ? Object.assign(chip(`${t.p}%`), { title: 'How sure Jev is that this tab fits' }) : el('span'));
      list.append(li);
    }
  }
  c.append(list);
  const go = el('button', 'btn primary pv-go');
  const count = () => list.querySelectorAll('input:checked').length + pv.merging.reduce((a, m) => a + m.count, 0);
  const label = () => { const n = count(); go.textContent = pv.target ? `Move ${n} tab${n === 1 ? '' : 's'}` : `Take ${n} out`; go.disabled = !n; };
  list.addEventListener('change', label);
  label();
  go.onclick = async () => {
    const ids = [...list.querySelectorAll('input:checked')].map((x) => Number(x.getAttribute('data-id')));
    const plan = pv.target ? { ...pv.plan, moveTabIds: ids } : { ungroupTabIds: ids };
    go.disabled = true;
    const r = await call({ type: 'askApply', plan });
    c.classList.remove('active');
    if (r) handle(r);
  };
  c.append(go);
  thread.append(c);
  scrollDown();
}

$('askUndo').onclick = async () => {
  const r = await call({ type: 'askUndo' });
  if (!r) return;
  $('askToast').hidden = true; $('askToastText').textContent = '';
  say(r.restored ? `Undone. Put ${r.restored} tab${r.restored === 1 ? '' : 's'} back where they were.` : 'Nothing to undo.');
  load();
};
