import { DEFAULTS, DEFAULT_USE_CASES, GROUP_COLORS, loadSettings, saveSettings } from '../lib/settings.js';

/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const BOOL = ['closeVariants', 'autoCloseDuplicates', 'readPageText', 'autoTuneUseCases', 'useJevForGrouping', 'useJevForClosing', 'sendTitles', 'sendPaths', 'crossWindowDedupe', 'respectManualGroups',
  'reorderGroupsAsBlocks', 'autoOrderGroups', 'linkInference', 'autoEnabled', 'autoDedupe', 'autoCloseChildren', 'autoGroup', 'autoReorder'];
const NUM = ['minGroupSize', 'dupIdleMinutes', 'staleMinutes', 'transientMinutes', 'halfLifeDays', 'autoIntervalMin', 'autoCloseConfidence', 'minChoiceConfidence'];
const LISTS = ['aiExcludedDomains', 'protectedDomains'];
const SWATCH = { grey: '#8a8f98', blue: '#3b82f6', red: '#ef4444', yellow: '#eab308', green: '#22c55e', pink: '#ec4899', purple: '#a855f7', cyan: '#06b6d4', orange: '#f97316' };

let useCases = [];
let dirty = false;
let usage = {};
let suggestions = null;

function markDirty() {
  dirty = true;
  $('save').disabled = false;
  $('saveState').textContent = 'Unsaved changes';
  $('savebar').classList.add('dirty');
}

function fill(s) {
  $('jevApiKey').value = s.jevApiKey || '';
  $('jevBaseUrl').value = s.jevBaseUrl || DEFAULTS.jevBaseUrl;
  const known = ['jev-latest', 'jev-preview'].includes(s.jevModel);
  $('jevModel').value = known ? s.jevModel : '__custom';
  $('jevModelCustom').hidden = known;
  $('jevModelCustom').value = known ? '' : s.jevModel;
  for (const k of BOOL) $(k).checked = !!s[k];
  for (const r of document.querySelectorAll('input[name=groupingMode]')) /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === s.groupingMode;
  for (const r of document.querySelectorAll('input[name=groupOrder]')) /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === s.groupOrder;
  for (const k of NUM) $(k).value = s[k];
  for (const k of LISTS) $(k).value = (s[k] || []).join('\n');
  useCases = structuredClone(s.useCases || DEFAULT_USE_CASES);
  renderUseCases();
  syncOutputs();
  keyState(s.jevApiKey);
}

function keyState(key) {
  $('keyState').textContent = key ? 'Key set' : 'No key';
  $('keyState').className = 'chip' + (key ? ' sure' : ' maybe');
}

function syncOutputs() {
  $('autoCloseConfidenceOut').textContent = Math.round($('autoCloseConfidence').value * 100) + '%';
  $('minChoiceConfidenceOut').textContent = Math.round($('minChoiceConfidence').value * 100) + '%';
}

function renderUseCases() {
  const box = $('useCases');
  box.replaceChildren();
  useCases.forEach((u, i) => {
    const row = document.createElement('div');
    row.className = 'uc';
    const name = Object.assign(document.createElement('input'), { type: 'text', value: u.name, placeholder: 'Name', maxLength: 24 });
    name.setAttribute('aria-label', 'Use case name');
    name.oninput = () => { u.name = name.value; markDirty(); };
    const color = document.createElement('select');
    color.setAttribute('aria-label', 'Group color');
    for (const c of GROUP_COLORS) color.append(new Option(c, c, false, c === u.color));
    color.oninput = () => { u.color = color.value; markDirty(); };
    const desc = Object.assign(document.createElement('input'), { type: 'text', value: u.description || '', placeholder: 'What belongs here (helps Jev decide)', className: 'desc' });
    desc.setAttribute('aria-label', 'Use case description');
    desc.oninput = () => { u.description = desc.value; markDirty(); };
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn ghost del', textContent: '✕', title: 'Remove' });
    del.setAttribute('aria-label', `Remove ${u.name}`);
    del.onclick = () => { useCases.splice(i, 1); renderUseCases(); markDirty(); };
    color.style.borderLeft = `4px solid ${SWATCH[u.color] || SWATCH.grey}`;
    color.addEventListener('input', () => (color.style.borderLeft = `4px solid ${SWATCH[color.value]}`));
    row.append(name, color, desc, del);
    const ev = usage[u.name];
    if ((u.sites && u.sites.length) || ev) {
      const line = document.createElement('div');
      line.className = 'uc-sites';
      const sites = (u.sites && u.sites.length ? u.sites : ev?.sites || []).slice(0, 5).join(', ');
      if (sites) { const b = document.createElement('b'); b.textContent = 'Usually on '; line.append(b, sites); }
      if (ev) line.append(`${sites ? ' · ' : ''}${ev.n} tab${ev.n === 1 ? '' : 's'} grouped here`);
      if (u.learned) { const t = document.createElement('span'); t.className = 'uc-badge'; t.textContent = 'Learned'; line.append(t); }
      row.append(line);
    }
    box.append(row);
  });
}

function collect() {
  const s = {};
  s.jevApiKey = $('jevApiKey').value.trim();
  s.jevBaseUrl = ($('jevBaseUrl').value.trim() || DEFAULTS.jevBaseUrl).replace(/\/+$/, '');
  s.jevModel = $('jevModel').value === '__custom' ? ($('jevModelCustom').value.trim() || 'jev-latest') : $('jevModel').value;
  for (const k of BOOL) s[k] = $(k).checked;
  s.groupingMode = /** @type {HTMLInputElement} */ (document.querySelector('input[name=groupingMode]:checked'))?.value || 'goals';
  s.groupOrder = /** @type {HTMLInputElement} */ (document.querySelector('input[name=groupOrder]:checked'))?.value || 'recent';
  for (const k of NUM) s[k] = Number($(k).value) || DEFAULTS[k];
  for (const k of LISTS) s[k] = $(k).value.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  s.useCases = useCases.filter((u) => u.name && u.name.trim()).map((u) => ({ ...u, name: u.name.trim() }));
  return s;
}

/** Permissions must be requested from a click, so Save and Test do it. */
async function ensurePermissions(s) {
  const origin = (() => { try { return new URL(s.jevBaseUrl).origin; } catch { return null; } })();
  const req = { permissions: [], origins: [] };
  if (origin && origin !== 'https://api.typesafe.ai') req.origins.push(origin + '/*');
  if (s.linkInference || s.readPageText) { req.permissions.push('scripting'); req.origins.push('<all_urls>'); }
  if (!req.origins.length) return;
  // One request per click: Chrome only honors permission prompts made directly from a user gesture.
  const ok = await chrome.permissions.request(req);
  if (!ok) {
    if (origin && origin !== 'https://api.typesafe.ai') throw new Error(`Tab Land needs access to ${origin} to call Jev there.`);
    s.linkInference = false; s.readPageText = false;
    $('linkInference').checked = false; $('readPageText').checked = false;
  }
}

async function save() {
  const s = collect();
  try {
    await ensurePermissions(s);
    await saveSettings(s);
    dirty = false;
    $('save').disabled = true;
    $('saveState').textContent = 'Saved';
    $('savebar').classList.remove('dirty');
    keyState(s.jevApiKey);
  } catch (e) {
    $('saveState').textContent = e.message;
  }
}

document.addEventListener('input', (/** @type {any} */ e) => {
  if (e.target.closest('.card')) markDirty();
  if (e.target.type === 'range') syncOutputs();
});

$('jevModel').onchange = () => { $('jevModelCustom').hidden = $('jevModel').value !== '__custom'; };
$('toggleKey').onclick = () => {
  const show = $('jevApiKey').type === 'password';
  $('jevApiKey').type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? 'Hide' : 'Show';
};
$('testKey').onclick = async () => {
  const out = $('testResult');
  const s = collect();
  if (!s.jevApiKey) { out.textContent = 'Paste a key first.'; out.className = 'hint err'; return; }
  out.textContent = 'Checking…'; out.className = 'hint';
  try {
    await ensurePermissions({ ...s, linkInference: false });
    const r = await chrome.runtime.sendMessage({ type: 'testKey', settings: s });
    if (r?.error) throw new Error(r.error);
    out.textContent = `Connected.${r.models?.length ? ' Models: ' + r.models.join(', ') : ''}`;
    out.className = 'hint ok';
  } catch (e) {
    out.textContent = e.message;
    out.className = 'hint err';
  }
};
$('addUseCase').onclick = () => {
  useCases.push({ name: '', color: GROUP_COLORS[useCases.length % GROUP_COLORS.length], description: '' });
  renderUseCases();
  markDirty();
  $('useCases').lastElementChild.querySelector('input').focus();
};
$('resetUseCases').onclick = () => { useCases = structuredClone(DEFAULT_USE_CASES); renderUseCases(); markDirty(); };
$('resetLearned').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'resetLearned' });
  $('resetLearned').textContent = 'Forgotten';
  setTimeout(() => ($('resetLearned').textContent = 'Forget everything learned'), 2000);
};
$('save').onclick = save;
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } });
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- learning ----------

function renderLearn() {
  const s = suggestions;
  const ul = $('learnList');
  ul.replaceChildren();
  const items = [
    ...s.add.map((a) => ({ type: 'add', label: 'Add', what: a.name, why: `${a.sites.join(', ')}${a.via === 'jev' ? ' · named by Jev' : ''}`, data: a })),
    ...s.enrich.map((e) => ({ type: 'enrich', label: 'Update', what: e.name, why: `Usually on ${e.sites.join(', ')}`, data: e })),
    ...s.retire.map((n) => ({ type: 'retire', label: 'Remove', what: n, why: 'No tabs grouped here in the last 14 days', data: n })),
  ];
  for (const [i, it] of items.entries()) {
    const li = document.createElement('li');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: it.type !== 'retire' });
    cb.dataset.i = String(i);
    const k = Object.assign(document.createElement('span'), { className: `kind ${it.type}`, textContent: it.label });
    const txt = document.createElement('div');
    txt.append(Object.assign(document.createElement('div'), { className: 'what', textContent: it.what }), Object.assign(document.createElement('div'), { className: 'why', textContent: it.why }));
    li.append(cb, k, txt);
    ul.append(li);
  }
  suggestions.items = items;
  $('learnMeta').textContent = items.length
    ? `Based on ${s.evidence} grouped tab${s.evidence === 1 ? '' : 's'} and the sites you use together.${s.jevError ? ` Jev couldn't name clusters (${s.jevError}); using site names.` : ''}`
    : `Nothing to change yet. Tab Land learns as you browse and group${s.evidence ? ` (${s.evidence} grouped tabs so far)` : ''}.`;
  $('learnApply').hidden = !items.length;
  $('learnPanel').hidden = false;
}

$('learnBtn').onclick = async () => {
  if (dirty) await save();
  $('learnBtn').textContent = 'Learning…';
  try {
    suggestions = await chrome.runtime.sendMessage({ type: 'learn' });
    if (suggestions?.error) throw new Error(suggestions.error);
    usage = suggestions.usage || {};
    renderLearn();
    renderUseCases();
  } catch (e) {
    $('learnMeta').textContent = e.message; $('learnPanel').hidden = false;
  } finally { $('learnBtn').textContent = 'Learn from my tabs'; }
};
$('learnClose').onclick = () => { $('learnPanel').hidden = true; };
$('learnApply').onclick = async () => {
  const picked = [...$('learnList').querySelectorAll('input:checked')].map((cb) => suggestions.items[+cb.dataset.i]);
  const changes = { add: [], enrich: [], retire: [] };
  for (const it of picked) changes[it.type].push(it.data);
  const r = await chrome.runtime.sendMessage({ type: 'applyLearn', changes });
  useCases = structuredClone(r.useCases);
  renderUseCases();
  $('learnPanel').hidden = true;
  $('saveState').textContent = `Applied ${picked.length} change${picked.length === 1 ? '' : 's'}`;
};

// ---------- regroup ----------

async function syncUndoRegroupBtn() {
  const st = await chrome.runtime.sendMessage({ type: 'regroupState' }).catch(() => null);
  $('undoRegroupBtn').hidden = !st?.canUndo;
}
let savedMode = null;
$('regroupNow').onclick = async () => {
  if (dirty) await save();
  const out = $('regroupResult');
  $('regroupNow').textContent = 'Regrouping…';
  $('regroupNow').disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'regroup', includeManual: $('regroupManual').checked });
    if (r?.error) throw new Error(r.error);
    const names = [...new Set(r.groups.map((g) => g.name))];
    out.textContent = names.length ? `Ungrouped ${r.regrouped} group${r.regrouped === 1 ? '' : 's'}, made ${names.length}: ${names.join(', ')}` : `Ungrouped ${r.regrouped} group${r.regrouped === 1 ? '' : 's'}. Nothing worth regrouping yet.`;
    out.className = r.error ? 'hint err' : 'hint ok';
  } catch (e) {
    out.textContent = e.message; out.className = 'hint err';
  } finally {
    $('regroupNow').textContent = 'Regroup now';
    $('regroupNow').disabled = false;
    syncUndoRegroupBtn();
  }
};
$('undoRegroupBtn').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'undoRegroup' });
  $('regroupResult').textContent = `Restored ${r.restored} group${r.restored === 1 ? '' : 's'}.`;
  $('regroupResult').className = 'hint ok';
  syncUndoRegroupBtn();
};
// Nudge after a mode switch: existing groups were made the old way.
for (const r of document.querySelectorAll('input[name=groupingMode]')) {
  r.addEventListener('change', () => {
    const v = /** @type {HTMLInputElement} */ (document.querySelector('input[name=groupingMode]:checked'))?.value;
    $('regroupHint').textContent = v !== savedMode
      ? `Your existing groups were made ${savedMode === 'useCases' ? 'by use case' : 'by goal'}. Regroup now to rebuild them ${v === 'useCases' ? 'by use case' : 'by goal'}. You can undo it.`
      : "Ungroups Tab Land's groups and rebuilds them with the mode above. Use this after switching modes. You can undo it.";
  });
}
syncUndoRegroupBtn();

// ---------- tuning export ----------
$('exportTuning').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'exportTuning' });
  if (r?.error) { $('exportResult').textContent = r.error; $('exportResult').className = 'hint err'; return; }
  const blob = new Blob([JSON.stringify(r, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'tab-land-tuning.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('exportResult').textContent = `Saved ${r.tabs.length} tabs to your Downloads folder as tab-land-tuning.json.`;
  $('exportResult').className = 'hint ok';
};

loadSettings().then((s) => { savedMode = s.groupingMode; fill(s); });
chrome.runtime.sendMessage({ type: 'useCaseUsage' }).then((r) => { if (r && !r.error) { usage = r; renderUseCases(); } }).catch(() => {});
