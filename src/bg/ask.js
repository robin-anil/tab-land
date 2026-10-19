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
import { runAll, buildMatchRequests, parseNoulResponses } from '../lib/jev.js';
import { parseInstruction, resolveGroup, exactSelection, localMatch, includeQuestions, lookAlikes, SURE, MAYBE } from '../lib/ask.js';
import { withRetry } from './util.js';

const HELP = 'I can move, merge, rename and ungroup tabs. Try "Move the dashboards into Growth", "Merge Growth 2 into Growth" or "Take the LinkedIn tabs out of Hiring".';
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
  const instruction = String(text || '').slice(0, 300);
  const intent = parseInstruction(instruction);
  if (intent.kind === 'unknown') return { reply: HELP };
  const st = await live(ctx);
  const { tabs, groups } = st;
  const notFound = (name) => ({ reply: `I can't find a group called “${name}”. Your groups: ${groups.filter((g) => g.title).slice(0, 8).map((g) => g.title).join(', ') || 'none yet'}.` });

  if (intent.kind === 'merge') {
    let sources = [];
    for (const name of intent.from) {
      const r = resolveGroup(name, groups);
      if (!r.candidates.length) return notFound(name);
      sources.push(...(r.match ? [r.match] : r.candidates)); // "merge the Growth groups": all of them
    }
    let into;
    if (intent.into) {
      const r = resolveGroup(intent.into, groups);
      if (r.match) into = r.match;
      else if (r.candidates.length) into = [...r.candidates].sort((a, b) => b.count - a.count)[0], sources.push(...r.candidates);
      else return notFound(intent.into);
    } else {
      into = [...sources].sort((a, b) => b.count - a.count)[0];
    }
    sources = [...new Map(sources.filter((g) => g.id !== into.id).map((g) => [g.id, g])).values()];
    if (!sources.length) return { reply: `“${into.title}” is already one group.` };
    return applyNow(ctx, { targetId: into.id, targetName: into.title, mergeIds: sources.map((g) => g.id) });
  }

  if (intent.kind === 'rename' || intent.kind === 'ungroup') {
    const r = resolveGroup(intent.group, groups);
    if (!r.candidates.length) return notFound(intent.group);
    if (!r.match) return { reply: `There are ${r.candidates.length} groups called “${r.candidates[0].title}”. Say which, for example “${intent.kind === 'rename' ? 'Rename' : 'Ungroup'} ${r.candidates[0].title}” after merging them.` };
    if (intent.kind === 'rename') return applyNow(ctx, { renameId: r.match.id, renameTo: intent.to.slice(0, 60) });
    return applyNow(ctx, { ungroupTabIds: tabs.filter((t) => t.groupId === r.match.id).map((t) => t.id) });
  }

  // ---- move ----
  let fromIds = null;
  if (intent.from) {
    const r = resolveGroup(intent.from, groups);
    if (!r.candidates.length) return notFound(intent.from);
    fromIds = (r.match ? [r.match] : r.candidates).map((g) => g.id);
  }
  let target = null;
  let targetCandidates = [];
  const targetName = intent.into ? intent.into.slice(0, 60) : null;
  if (targetName) {
    const r = resolveGroup(targetName, groups);
    if (r.match) target = r.match;
    else targetCandidates = r.candidates;
  } else if (!fromIds) {
    return { reply: 'Say where they should go, for example “into Growth”, or which group to take them out of.' };
  }
  const inTarget = (t) => (target ? t.groupId === target.id : targetCandidates.some((g) => g.id === t.groupId));
  const pool = tabs.filter((t) => (fromIds ? fromIds.includes(t.groupId) : true) && !inTarget(t));
  if (!pool.length) return { reply: fromIds ? 'That group has no tabs I can move.' : 'There are no tabs to move.' };

  const sure = new Map();
  const unsure = new Map();
  let guessed = false;
  let via = 'exact';
  let error = null;
  const exact = exactSelection(intent.what, pool, groups);
  if (exact) {
    for (const id of exact.tabIds) sure.set(id, 1);
  } else {
    guessed = true;
    const useJev = !!ctx.settings.jevApiKey;
    const sendable = useJev ? pool.filter(ctx.aiAllowed) : [];
    let probs = new Map();
    if (sendable.length) {
      const reqs = buildMatchRequests(sendable, { description: intent.what, target: targetName || '', settings: ctx.settings });
      const { results, errors } = await runAll(ctx.settings, reqs, { fetchImpl: ctx.fetch, retryDelay: ctx.jevRetryDelay });
      probs = parseNoulResponses(reqs, results);
      if (probs.size) via = 'jev';
      else if (errors.length) error = errors[0].message;
    }
    // Tabs Jev didn't judge (excluded domains, no key, a failed call) fall back to word matching.
    const local = localMatch(intent.what, pool.filter((t) => !probs.has(t.id)));
    if (via !== 'jev') via = 'words';
    for (const [id, p] of local) probs.set(id, p >= 0.99 ? 0.8 : p >= 0.5 ? 0.5 : 0);
    for (const [id, p] of probs) { if (p >= SURE) sure.set(id, p); else if (p >= MAYBE) unsure.set(id, p); }
  }
  if (!sure.size && !unsure.size) return { reply: `I couldn't find tabs that fit “${intent.what}”.${error ? ` (Jev: ${error})` : ''}` };

  const session = {
    v: 1, instruction, what: intent.what, targetName, targetId: target?.id ?? null,
    targetCandidates: targetCandidates.map((g) => g.id), fromIds, via,
    sure: [...sure].map(([id, p]) => [id, +p.toFixed(3)]), unsure: [...unsure].map(([id, p]) => [id, +p.toFixed(3)]),
  };
  const questions = buildQuestions(session, st);
  if (!guessed && !questions.length) return applyNow(ctx, planFrom(session, {}, st));
  session.questions = questions.map(({ id, kind, tabIds }) => ({ id, kind, tabIds: tabIds || [] }));
  if (questions.length) return { session, questions, error };
  return { session, preview: preview(session, {}, st), error };
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
  if (!session || session.v !== 1) return { reply: 'That question is out of date. Ask again.' };
  const st = await live(ctx);
  const a = answers && typeof answers === 'object' ? Object.fromEntries(Object.entries(answers).map(([k, v]) => [String(k), String(v)])) : {};
  const clean = sanitizeSession(session);
  const pv = preview(clean, a, st);
  if (!pv.tabs.length && !pv.merging.length) return { reply: 'Nothing left to move.' };
  return { session: clean, preview: pv };
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
