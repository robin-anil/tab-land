// Ask mode: move, merge, rename and ungroup tabs from a plain-English instruction.
//
//   askHome   groups and look-alike pairs for the empty Ask screen
//   askStart  parse the instruction; clear requests are done at once, guesses come back as questions
//             or a preview to check
//   askAnswer answers to the questions → the preview
//   askApply  carry out a checked plan
//   askUndo   put everything the last Ask change touched back
//
// Nothing is remembered between requests except the one-step undo.
import { isWebUrl } from '../lib/url.js';
import { hashColor } from '../lib/settings.js';
import { runAll, buildMatchRequests, buildRouteRequest, parseNoulResponses } from '../lib/jev.js';
import { includeQuestions, lookAlikes, nameSpans, readChoice, ACTIONS, ACTION_LABELS, SURE, MAYBE, ACT, ASK } from '../lib/ask.js';
import { withRetry } from './util.js';

const HELP = 'I can move tabs into groups, take them out, merge, rename and ungroup groups. Try “Move the dashboards into Growth” or “Merge Growth 2 into Growth”.';
const int = (v) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const ints = (xs) => (Array.isArray(xs) ? xs.map(int).filter((x) => x != null) : []);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function live(ctx) {
  await ctx.ready();
  await ctx.refreshSettings();
  const { chrome } = ctx;
  const all = await chrome.tabs.query({});
  const tabs = all.filter((t) => !t.pinned && !t.incognito && isWebUrl(t.url || '') && !(t.url || '').startsWith(ctx.ownPrefix()) && !ctx.isProtected(t));
  const raw = await chrome.tabGroups.query({});
  const groups = raw.map((g) => ({ id: g.id, title: g.title || '', color: g.color, windowId: g.windowId, count: all.filter((t) => t.groupId === g.id).length }));
  return { tabs, groups, byId: new Map(tabs.map((t) => [t.id, t])), gById: new Map(groups.map((g) => [g.id, g])) };
}

const pubGroup = (g) => (g ? { id: g.id, title: g.title, color: g.color, count: g.count, windowId: g.windowId } : null);

export async function askHome(ctx) {
  const { tabs, groups } = await live(ctx);
  const tabsByGroup = new Map();
  for (const t of tabs) if (t.groupId >= 0) { if (!tabsByGroup.has(t.groupId)) tabsByGroup.set(t.groupId, []); tabsByGroup.get(t.groupId).push(t); }
  const pairs = lookAlikes(groups.filter((g) => g.title && g.count), tabsByGroup);
  const { askUndo } = await ctx.chrome.storage.local.get('askUndo');
  return { groups: groups.map(pubGroup), lookAlikes: pairs.map((p) => ({ into: pubGroup(p.into), from: pubGroup(p.from) })), hasKey: !!ctx.settings.jevApiKey, canUndo: !!askUndo };
}

export async function askStart(ctx, { text }) {
  const instruction = String(text || '').trim().slice(0, 300);
  if (!instruction) return { reply: HELP };
  const st = await live(ctx);
  if (!ctx.settings.jevApiKey) return { reply: 'Ask needs a Jev API key to read what you typed. Add one in Settings.' };
  const r = await readRequest(ctx, instruction, st);
  if (r.reply) return r;
  return continueRoute(ctx, { v: 2, kind: 'route', instruction, route: r.route }, {}, st);
}

// ---- step 1: Jev reads the request ----

async function readRequest(ctx, instruction, st) {
  const s = ctx.settings;
  const groups = st.groups.filter((g) => g.count).map((g) => ({
    ...g, examples: st.tabs.filter((t) => t.groupId === g.id && ctx.aiAllowed(t)).slice(0, 3).map((t) => t.title || ''),
  }));
  const req = buildRouteRequest(instruction, { groups, spans: nameSpans(instruction), actions: ACTIONS, settings: s });
  const { results, errors } = await runAll(s, [req], { fetchImpl: ctx.fetch, retryDelay: ctx.jevRetryDelay });
  const a = results[0]?.answers;
  if (!a) return { reply: `Jev couldn't read that just now${errors[0] ? ` (${errors[0].message})` : ''}. Try again in a moment.` };
  const slot = (x) => {
    const c = readChoice(x);
    if (!c) return { value: null, confidence: 0, top: [] };
    const map = (k) => (req.gKey.has(k) ? req.gKey.get(k) : k === 'new' ? 'new' : null);
    return { value: map(c.key), confidence: c.confidence, top: c.top.map(([k, p]) => [map(k), +p.toFixed(3)]) };
  };
  const action = readChoice(a.action);
  const name = readChoice(a.new_name);
  const merge = [...req.mergeKey].filter(([q]) => (a[q]?.noul ?? 0) >= 0.5).map(([, id]) => id);
  return {
    route: {
      action: action ? { value: action.key in ACTIONS ? action.key : 'none', confidence: action.confidence, top: action.top.map(([k, p]) => [k, +p.toFixed(3)]) } : { value: 'none', confidence: 0, top: [] },
      destination: slot(a.destination), subject: slot(a.subject),
      newName: name && req.spanKey.has(name.key) ? { value: req.spanKey.get(name.key), confidence: name.confidence } : { value: null, confidence: name?.confidence ?? 0 },
      merge,
    },
  };
}

const groupLabel = (g) => `${g.title || 'Untitled'} · ${plural(g.count, 'tab')}`;
const titleCase = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);

/** Ask back when Jev isn't sure: the likeliest options, as buttons. */
function pickQuestion(id, text, top, st, { allowNew = false } = {}) {
  const options = [];
  for (const [v] of top) {
    if (v === 'new' && allowNew) options.push({ value: 'new', label: 'A new group' });
    else if (v != null && st.gById.get(v)) options.push({ value: String(v), label: groupLabel(st.gById.get(v)) });
  }
  return options.length ? { id, kind: 'pick', text, options } : null;
}

/**
 * Step 2 onward: decide what to do with Jev's reading and any answers so far. Everything Jev was
 * sure of (ACT) goes ahead with Undo; anything less is asked about first.
 */
async function continueRoute(ctx, session, answers, st) {
  const R = session.route;
  let sure = true;
  const conf = (c) => { if (c < ACT) sure = false; return c; };

  // What to do
  const action = answers.action || R.action.value;
  if (!answers.action) {
    if (R.action.confidence < ASK && R.action.top.length > 1) {
      return { session, questions: [{ id: 'action', kind: 'pick', text: 'What would you like to do?', options: R.action.top.filter(([k]) => k !== 'none').map(([k]) => ({ value: k, label: ACTION_LABELS[k] })) }] };
    }
    conf(R.action.confidence);
  }
  if (!(action in ACTIONS) || action === 'none') return { reply: HELP };

  // Which group(s)
  const need = (slotName, text, opts = {}) => {
    const key = slotName;
    if (answers[key]) return { value: answers[key] === 'new' ? 'new' : Number(answers[key]) };
    const sl = R[slotName];
    if (sl.value == null || sl.confidence < ASK) {
      const q = pickQuestion(key, text, sl.top.length ? sl.top : [], st, opts);
      if (q && (sl.value == null ? q.options.length >= 1 : q.options.length > 1)) return { question: q };
      if (sl.value == null) return { missing: true };
    }
    conf(sl.confidence);
    return { value: sl.value };
  };
  const ask = (q) => ({ session, questions: [q] });
  const groupOf = (id) => (id != null && id !== 'new' ? st.gById.get(id) || null : null);
  const newName = R.newName.value ? titleCase(R.newName.value) : null;

  if (action === 'rename' || action === 'ungroup') {
    const subj = need('subject', action === 'rename' ? 'Which group should get the new name?' : 'Which group should I ungroup?');
    if (subj.question) return ask(subj.question);
    const g = groupOf(subj.value);
    if (!g) return { reply: `I couldn't tell which group you mean. ${HELP}` };
    if (action === 'ungroup') {
      const plan = { ungroupTabIds: st.tabs.filter((t) => t.groupId === g.id).map((t) => t.id) };
      return confirmOrApply(ctx, session, answers, sure, `Ungroup ${g.title || 'this group'} (${plural(g.count, 'tab')})?`, plan);
    }
    if (!newName) return { reply: `What should ${g.title || 'it'} be called? Say it like “Rename ${g.title || 'it'} to …”.` };
    conf(R.newName.confidence);
    if ((g.title || '') === newName) return { reply: `It's already called ${newName}.` };
    const clash = st.groups.find((x) => x.id !== g.id && (x.title || '').toLowerCase() === newName.toLowerCase());
    if (clash && !answers.clash) {
      return ask({ id: 'clash', kind: 'clash', text: `There's already a group called ${clash.title} (${plural(clash.count, 'tab')}). Merge ${g.title || 'this group'} into it?`, options: [{ value: 'merge', label: `Merge into ${clash.title}` }, { value: 'keep', label: 'Keep both' }] });
    }
    if (clash && answers.clash === 'merge') return applyNow(ctx, { targetId: clash.id, targetName: clash.title, mergeIds: [g.id] });
    return confirmOrApply(ctx, session, answers, sure && !answers.clash, `Rename ${g.title || 'the group'} to ${newName}?`, { renameId: g.id, renameTo: newName });
  }

  if (action === 'merge') {
    const dest = need('destination', 'Which group should they be merged into?', { allowNew: true });
    if (dest.question) return ask(dest.question);
    const into = groupOf(dest.value);
    let sources = [...R.merge];
    if (R.subject.value != null && R.subject.value !== 'new') sources.push(R.subject.value);
    sources = [...new Set(sources)].filter((id) => id !== into?.id && st.gById.has(id));
    if (!sources.length) return { reply: 'Which groups should I merge? Say it like “Merge Growth 2 into Growth”.' };
    if (!into) {
      if (!newName) return { reply: 'What should the merged group be called?' };
      const ids = st.tabs.filter((t) => sources.includes(t.groupId)).map((t) => t.id);
      return confirmOrApply(ctx, session, answers, sure, `Merge ${sources.map((id) => st.gById.get(id).title).join(', ')} into a new group, ${newName}?`, { targetId: null, targetName: newName, moveTabIds: ids, mergeIds: [] });
    }
    return confirmOrApply(ctx, session, answers, sure, `Merge ${sources.map((id) => st.gById.get(id).title || 'Untitled').join(', ')} into ${into.title}?`, { targetId: into.id, targetName: into.title, mergeIds: sources });
  }

  // move / take_out: which group, then which tabs
  let target = null;
  let targetName = null;
  if (action === 'move') {
    const dest = need('destination', 'Which group should they go into?', { allowNew: true });
    if (dest.question) return ask(dest.question);
    if (dest.missing) return { reply: 'Where should they go? Name a group, for example “… into Growth”.' };
    target = groupOf(dest.value);
    targetName = target ? target.title : newName;
    if (!targetName) return { reply: 'What should the new group be called? Say it like “… into a new group called Research”.' };
  }
  let fromIds = null;
  const subjOk = R.subject.value != null && R.subject.value !== 'new' && R.subject.value !== target?.id;
  if (answers.subject) fromIds = [Number(answers.subject)];
  else if (subjOk && R.subject.confidence >= ASK) fromIds = [R.subject.value];
  else if (action === 'take_out') {
    const subj = need('subject', 'Which group should they come out of?');
    if (subj.question) return ask(subj.question);
  }
  const pool = st.tabs.filter((t) => ctx.aiAllowed(t) && (fromIds ? fromIds.includes(t.groupId) : action === 'take_out' ? t.groupId >= 0 : true) && (!target || t.groupId !== target.id));
  if (!pool.length) return { reply: 'There are no tabs there I can move.' };
  const reqs = buildMatchRequests(pool, { description: session.instruction, target: targetName || '', settings: ctx.settings });
  const { results, errors } = await runAll(ctx.settings, reqs, { fetchImpl: ctx.fetch, retryDelay: ctx.jevRetryDelay });
  const probs = parseNoulResponses(reqs, results);
  if (!probs.size) return { reply: `Jev couldn't check your tabs just now${errors[0] ? ` (${errors[0].message})` : ''}.` };
  const sureTabs = [...probs].filter(([, p]) => p >= SURE);
  const unsure = [...probs].filter(([, p]) => p >= MAYBE && p < SURE);
  if (!sureTabs.length && !unsure.length) return { reply: 'I couldn\'t find tabs that fit that.' };
  const move = {
    v: 1, instruction: session.instruction, what: session.instruction, targetName, targetId: target?.id ?? null,
    targetCandidates: [], fromIds, via: 'jev',
    sure: sureTabs.map(([id, p]) => [id, +p.toFixed(3)]), unsure: unsure.map(([id, p]) => [id, +p.toFixed(3)]),
  };
  const questions = buildQuestions(move, st);
  move.questions = questions.map(({ id, kind, tabIds }) => ({ id, kind, tabIds: tabIds || [] }));
  if (sure && !questions.length) return applyNow(ctx, planFrom(move, {}, st));
  if (questions.length) return { session: move, questions };
  return { session: move, preview: preview(move, {}, st) };
}

/** Sure → do it (Undo is there). Not quite sure → one Yes/No first. */
async function confirmOrApply(ctx, session, answers, sure, text, plan) {
  if (sure || answers.confirm === 'yes') return applyNow(ctx, plan);
  if (answers.confirm === 'no') return { reply: 'OK, nothing changed. Try saying it another way.' };
  return { session, questions: [{ id: 'confirm', kind: 'confirm', text, options: [{ value: 'yes', label: 'Yes, do it' }, { value: 'no', label: 'No' }] }] };
}


function buildQuestions(session, st) {
  const out = [];
  const where = session.targetName ? `part of ${session.targetName}` : 'coming out too';
  for (const q of includeQuestions(session.unsure.map(([id]) => id), st.byId)) {
    out.push({
      id: q.id, kind: 'include', tabIds: q.tabIds, samples: q.samples, more: Math.max(0, q.tabIds.length - q.samples.length),
      text: q.term ? `Are the “${q.term}” tabs ${where} too?` : `Should these ${plural(q.tabIds.length, 'tab')} be ${where} too?`,
      options: [{ value: 'yes', label: 'Yes, include them' }, { value: 'no', label: 'No, leave them' }],
    });
  }
  if (session.targetCandidates.length > 1) {
    const cands = session.targetCandidates.map((id) => st.gById.get(id)).filter(Boolean);
    out.push({
      id: 'target', kind: 'target',
      text: `There are ${cands.length} groups called ${session.targetName}. Which one?`,
      options: [{ value: 'merge', label: 'Merge them into one' }, ...cands.map((g) => ({ value: String(g.id), label: `${g.title} · ${plural(g.count, 'tab')}` }))],
    });
  }
  return out;
}

/** Answers + session → a concrete plan of ids. */
function planFrom(session, answers, st) {
  const ids = new Set(session.sure.map(([id]) => id));
  for (const q of session.questions || []) if (q.kind === 'include' && answers[q.id] === 'yes') q.tabIds.forEach((id) => ids.add(id));
  let targetId = session.targetId;
  let mergeIds = [];
  const cands = session.targetCandidates.map((id) => st.gById.get(id)).filter(Boolean);
  if (targetId == null && cands.length) {
    const a = answers.target;
    if (a && a !== 'merge' && cands.some((g) => String(g.id) === a)) targetId = Number(a);
    else { const big = [...cands].sort((x, y) => y.count - x.count)[0]; targetId = big.id; mergeIds = cands.filter((g) => g.id !== big.id).map((g) => g.id); }
  }
  const moveTabIds = [...ids].filter((id) => st.byId.has(id));
  if (!session.targetName) return { ungroupTabIds: moveTabIds };
  return { targetId, targetName: session.targetName, mergeIds, moveTabIds };
}

function preview(session, answers, st) {
  const plan = planFrom(session, answers, st);
  const p = new Map([...session.sure, ...session.unsure]);
  const yes = new Set((session.questions || []).filter((q) => answers[q.id] === 'yes').flatMap((q) => q.tabIds));
  const ids = plan.moveTabIds || plan.ungroupTabIds || [];
  const target = plan.targetId != null ? st.gById.get(plan.targetId) : null;
  const merging = (plan.mergeIds || []).map((id) => st.gById.get(id)).filter(Boolean);
  const tabs = ids.map((id) => {
    const t = st.byId.get(id);
    return { id, title: t.title || t.url, favIconUrl: t.favIconUrl || '', p: session.via === 'exact' ? null : Math.round((p.get(id) ?? 1) * 100), from: st.gById.get(t.groupId)?.title || null, section: yes.has(id) ? 'yes' : 'fit' };
  });
  const fromGroups = new Set(tabs.map((t) => t.from).filter(Boolean)).size;
  return {
    plan,
    target: plan.targetName ? { name: plan.targetName, isNew: !target, color: target?.color || hashColor(plan.targetName), count: target?.count || 0 } : null,
    merging: merging.map(pubGroup),
    tabs, fromGroups,
    total: tabs.length + merging.reduce((a, g) => a + g.count, 0),
  };
}

export async function askAnswer(ctx, { session, answers }) {
  if (!session || (session.v !== 1 && session.v !== 2)) return { reply: 'That question is out of date. Ask again.' };
  const st = await live(ctx);
  const a = answers && typeof answers === 'object' ? Object.fromEntries(Object.entries(answers).map(([k, v]) => [String(k), String(v)])) : {};
  if (session.kind === 'route') {
    const rs = sanitizeRoute(session);
    if (!rs) return { reply: 'That question is out of date. Ask again.' };
    return ctx.exclusive(() => continueRoute(ctx, rs, a, st));
  }
  const clean = sanitizeSession(session);
  const pv = preview(clean, a, st);
  if (!pv.tabs.length && !pv.merging.length) return { reply: 'Nothing left to move.' };
  return { session: clean, preview: pv };
}

function sanitizeRoute(s) {
  const r = s.route;
  if (!r || typeof r !== 'object') return null;
  const val = (v) => (v === 'new' ? 'new' : int(v));
  const top = (xs) => (Array.isArray(xs) ? xs.slice(0, 5).map(([v, p]) => [val(v), Number(p) || 0]) : []);
  const slot = (x) => ({ value: x ? val(x.value) : null, confidence: Number(x?.confidence) || 0, top: top(x?.top) });
  return {
    v: 2, kind: 'route', instruction: String(s.instruction || '').slice(0, 300),
    route: {
      action: { value: String(r.action?.value || 'none'), confidence: Number(r.action?.confidence) || 0, top: Array.isArray(r.action?.top) ? r.action.top.slice(0, 5).map(([k, p]) => [String(k), Number(p) || 0]) : [] },
      destination: slot(r.destination), subject: slot(r.subject),
      newName: { value: r.newName?.value ? String(r.newName.value).slice(0, 60) : null, confidence: Number(r.newName?.confidence) || 0 },
      merge: ints(r.merge),
    },
  };
}

function sanitizeSession(s) {
  const pairs = (xs) => (Array.isArray(xs) ? xs.filter((x) => Array.isArray(x) && int(x[0]) != null).map(([id, p]) => [int(id), Number(p) || 0]) : []);
  return {
    v: 1, instruction: String(s.instruction || ''), what: String(s.what || ''),
    targetName: s.targetName ? String(s.targetName).slice(0, 60) : null, targetId: int(s.targetId),
    targetCandidates: ints(s.targetCandidates), fromIds: s.fromIds ? ints(s.fromIds) : null, via: String(s.via || 'words'),
    sure: pairs(s.sure), unsure: pairs(s.unsure),
    questions: Array.isArray(s.questions) ? s.questions.map((q) => ({ id: String(q.id), kind: q.kind === 'target' ? 'target' : 'include', tabIds: ints(q.tabIds) })) : [],
  };
}

export async function askApply(ctx, { plan }) {
  const p = plan && typeof plan === 'object' ? plan : {};
  return applyNow(ctx, {
    targetId: int(p.targetId), targetName: p.targetName ? String(p.targetName).slice(0, 60) : null,
    mergeIds: ints(p.mergeIds), moveTabIds: ints(p.moveTabIds), ungroupTabIds: ints(p.ungroupTabIds),
  });
}

/** Carry out a plan; snapshot what it touches so askUndo can put it back. */
async function applyNow(ctx, plan) {
  const { chrome } = ctx;
  const r = (fn) => withRetry(fn, { timers: ctx.timers });
  const all = await chrome.tabs.query({});
  const byId = new Map(all.map((t) => [t.id, t]));
  const gById = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
  const undo = { at: ctx.now(), tabs: [], groups: {}, rename: null };
  const touch = (t) => {
    if (undo.tabs.some((x) => x.id === t.id)) return;
    undo.tabs.push({ id: t.id, url: t.url || '', groupId: t.groupId, windowId: t.windowId, index: t.index });
    const g = gById.get(t.groupId);
    if (g && !undo.groups[g.id]) undo.groups[g.id] = { title: g.title || '', color: g.color, collapsed: !!g.collapsed, windowId: g.windowId };
  };
  const result = { moved: 0, merged: 0, ungrouped: 0, renamed: null, name: null, groupId: null, count: 0 };

  if (plan.renameId != null) {
    const g = gById.get(plan.renameId);
    if (!g) return { reply: 'That group is gone.' };
    undo.rename = { id: g.id, title: g.title || '' };
    await chrome.tabGroups.update(g.id, { title: plan.renameTo });
    const i = ctx.state.managedGroups.findIndex((n) => n.toLowerCase() === (g.title || '').toLowerCase());
    if (i >= 0) ctx.state.managedGroups[i] = plan.renameTo;
    result.renamed = { from: g.title || '', to: plan.renameTo };
  }

  const out = (plan.ungroupTabIds || []).map((id) => byId.get(id)).filter((t) => t && t.groupId >= 0);
  if (out.length) { out.forEach(touch); await r(() => chrome.tabs.ungroup(out.map((t) => t.id))); result.ungrouped = out.length; }

  const target = plan.targetId != null ? gById.get(plan.targetId) : null;
  if (plan.targetId != null && !target) return { reply: 'That group was closed in the meantime. Ask again.' };
  const mergeIds = (plan.mergeIds || []).filter((id) => gById.has(id) && id !== target?.id);
  const moving = [...new Set([...(plan.moveTabIds || []), ...all.filter((t) => mergeIds.includes(t.groupId)).map((t) => t.id)])]
    .map((id) => byId.get(id)).filter((t) => t && !t.pinned && (!target || t.groupId !== target.id));
  if (moving.length && (plan.targetName || target)) {
    const counts = new Map();
    for (const t of moving) counts.set(t.windowId, (counts.get(t.windowId) || 0) + 1);
    const windowId = target ? target.windowId : [...counts].sort((a, b) => b[1] - a[1])[0][0];
    moving.forEach(touch);
    for (const t of moving) if (t.windowId !== windowId) await r(() => chrome.tabs.move(t.id, { windowId, index: -1 }));
    let gid;
    if (target) {
      gid = target.id;
      await r(() => chrome.tabs.group({ groupId: gid, tabIds: moving.map((t) => t.id) }));
    } else {
      gid = await r(() => chrome.tabs.group({ tabIds: moving.map((t) => t.id), createProperties: { windowId } }));
      await chrome.tabGroups.update(gid, { title: plan.targetName, color: hashColor(plan.targetName), collapsed: false });
      undo.created = gid;
    }
    result.moved = moving.length;
    result.merged = mergeIds.length;
    result.mergedNames = mergeIds.map((id) => gById.get(id)?.title).filter(Boolean);
    result.groupId = gid;
    result.name = target?.title || plan.targetName;
    result.count = (await chrome.tabs.query({ groupId: gid })).length;
    result.isNew = !target;
  }
  if (!result.moved && !result.ungrouped && !result.renamed) return { reply: 'Nothing needed to change.' };
  await chrome.storage.local.set({ askUndo: undo });
  ctx.saveSoon();
  return { done: { ...result, message: doneMessage(result) }, canUndo: true };
}

function doneMessage(r) {
  if (r.renamed) return `Renamed ${r.renamed.from || 'the group'} to ${r.renamed.to}.`;
  const bits = [];
  if (r.merged && r.moved) {
    const names = r.mergedNames?.length ? r.mergedNames.join(', ') : plural(r.merged, 'group');
    return `Merged ${names} into ${r.name}. It now has ${plural(r.count, 'tab')}.`;
  }
  if (r.moved) bits.push(`Moved ${plural(r.moved, 'tab')} into ${r.isNew ? 'a new group, ' : ''}${r.name}.`);
  if (r.ungrouped) bits.push(`Took ${plural(r.ungrouped, 'tab')} out of their group.`);
  if (r.moved && !r.isNew) bits.push(`It now has ${plural(r.count, 'tab')}.`);
  return bits.join(' ');
}

/** Put every tab the last Ask change touched back in its old group, window and name. */
export async function askUndo(ctx) {
  const { chrome } = ctx;
  const { askUndo: u } = await chrome.storage.local.get('askUndo');
  if (!u) return { restored: 0 };
  const r = (fn) => withRetry(fn, { timers: ctx.timers });
  const live = new Map((await chrome.tabs.query({})).map((t) => [t.id, t]));
  const liveGroups = new Set((await chrome.tabGroups.query({})).map((g) => g.id));
  if (u.rename && liveGroups.has(u.rename.id)) await chrome.tabGroups.update(u.rename.id, { title: u.rename.title });
  const back = new Map();
  let restored = 0;
  for (const s of u.tabs || []) {
    const t = live.get(s.id);
    if (!t) continue;
    if (t.windowId !== s.windowId) {
      try { await chrome.windows.get(s.windowId); await r(() => chrome.tabs.move(s.id, { windowId: s.windowId, index: -1 })); } catch (e) { ctx.log(e, 'askUndo.move'); }
    }
    restored++;
    if (s.groupId < 0) { await r(() => chrome.tabs.ungroup(s.id)).catch((e) => ctx.log(e, 'askUndo.ungroup')); continue; }
    if (!back.has(s.groupId)) back.set(s.groupId, []);
    back.get(s.groupId).push(s.id);
  }
  for (const [old, ids] of back) {
    const info = u.groups?.[old] || { title: '', color: 'grey', collapsed: false, windowId: undefined };
    try {
      if (liveGroups.has(old)) await r(() => chrome.tabs.group({ groupId: old, tabIds: ids }));
      else {
        const gid = await r(() => chrome.tabs.group({ tabIds: ids, ...(info.windowId != null ? { createProperties: { windowId: info.windowId } } : {}) }));
        await chrome.tabGroups.update(gid, { title: info.title, color: info.color, collapsed: info.collapsed });
      }
    } catch (e) { ctx.log(e, 'askUndo.group'); }
  }
  await chrome.storage.local.remove('askUndo');
  return { restored };
}
