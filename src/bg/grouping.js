// Grouping. Two modes:
//   goals    (default) cluster tabs by the job they serve, using lineage, per-tab switching, open bursts
//            and shared title terms; Jev verifies each goal, prunes outliers and names goals whose tabs share
//            no words. Leftover tabs can still join a goal or fall back to a use case. Being on the same
//            site is never evidence on its own.
//   useCases group by the kind of work (Engineering, Hiring…), the original behavior.
import { siteKey, isWebUrl } from '../lib/url.js';
import { hashColor } from '../lib/settings.js';
import { buildLineage } from '../lib/lineage.js';
import { planGroups, relatedContext } from '../lib/grouping.js';
import { goalGraph, iterativeGoals, nameGoal, stableName, cohesion } from '../lib/goals.js';
import { recordAssignments } from '../lib/learn.js';
import { runAll, buildGroupingRequests, parseGroupingResponses, buildGoalRequests, parseGoalResponses } from '../lib/jev.js';
import { snapshot } from './context.js';
import { pageTextFor } from './pagetext.js';
import { withRetry, isMissingTabError } from './util.js';

const GOAL_KEEP_P = 0.45;   // Jev must think it's at least this likely the tabs serve one goal
const MEMBER_KEEP_P = 0.3;  // below this a tab is pulled out of the goal

export async function groupTabs(ctx) {
  await ctx.ready();
  await ctx.refreshSettings();
  const { chrome } = ctx;
  const s = ctx.settings;
  const now = ctx.now();
  const all = (await snapshot(ctx)).filter((t) => !t.url.startsWith(ctx.ownPrefix()));
  const groups = await chrome.tabGroups.query({});
  const titleById = new Map(groups.map((g) => [g.id, g.title || '']));
  const managed = new Set(ctx.state.managedGroups.map((n) => n.toLowerCase()));
  const isManual = (t) => t.groupId >= 0 && !managed.has((titleById.get(t.groupId) || '').toLowerCase());

  const candidates = all.filter((t) => !t.pinned && !t.incognito && isWebUrl(t.url) && !ctx.isProtected(t) && !(s.respectManualGroups && isManual(t)));
  if (candidates.length < 2) return { groups: [], via: 'none', mode: s.groupingMode };
  const byId = new Map(candidates.map((t) => [t.id, t]));
  const edges = buildLineage(all, { urlLineage: ctx.state.urlLineage, linkEdges: ctx.state.linkEdges });
  const existingColors = Object.fromEntries(groups.filter((g) => g.title).map((g) => [g.title.toLowerCase(), g.color]));
  const useJev = !!(s.jevApiKey && s.useJevForGrouping);
  const jevOpts = { fetchImpl: ctx.fetch, retryDelay: ctx.jevRetryDelay };
  let via = 'heuristic';
  const errors = [];

  // ---- goals ----
  let goals = [];
  if (s.groupingMode === 'goals') {
    const pageText = await pageTextFor(ctx, candidates).catch((e) => { ctx.log(e, 'pageText'); return new Map(); });
    const graph = goalGraph(candidates, { edges, tabPairs: ctx.state.tabPairs, now, halfLifeMs: ctx.hl(), pageText });
    // Iterative: strict clusters, then attach loose tabs to the nearest goal, then looser clusters.
    goals = iterativeGoals(candidates.map((t) => t.id), graph, { strict: s.goalThreshold }).map(({ ids, pass }) => /** @type {any} */ ({
      ids, pass,
      name: stableName(ids, byId, titleById, managed) || nameGoal(ids, graph.docs, graph.idf),
      cohesion: cohesion(ids, graph.w),
      via: 'heuristic',
    }));

    if (useJev && goals.length) {
      const checkable = goals.map((g) => ({ g, tabs: g.ids.map((id) => byId.get(id)).filter(ctx.aiAllowed) })).filter((x) => x.tabs.length >= 2);
      const reqs = buildGoalRequests(checkable.map((x) => ({ tabs: x.tabs, needName: !x.g.name })), { settings: s, exclude: s.useCases.map((u) => u.name) });
      const { results, errors: errs } = await runAll(s, reqs, jevOpts);
      const answers = parseGoalResponses(reqs, results);
      answers.forEach((a, i) => {
        if (!a) return;
        const g = checkable[i].g;
        g.via = 'jev';
        g.p = a.p;
        if (a.p != null && a.p < GOAL_KEEP_P) { g.rejected = true; return; }
        g.ids = g.ids.filter((id) => (a.members.get(id) ?? 1) >= MEMBER_KEEP_P);
        if (!g.name && a.name) g.name = a.name;
      });
      if (answers.some(Boolean)) via = 'jev';
      else if (errs.length) errors.push(errs[0].message);
      goals = goals.filter((g) => !g.rejected && g.ids.length >= 2);
    }
    for (const g of goals) g.name ||= fallbackGoalName(g.ids.map((id) => byId.get(id)));
    goals = dedupeNames(goals);
  }

  // ---- leftovers (or everything, in use-case mode) ----
  const inGoal = new Set(goals.flatMap((g) => g.ids));
  const rest = candidates.filter((t) => !inGoal.has(t.id));
  let jev = new Map();
  if (useJev && rest.length) {
    const sendable = rest.filter(ctx.aiAllowed);
    const related = relatedContext(sendable, { edges, pairs: ctx.state.pairs, now, halfLifeMs: ctx.hl(), groupTitles: titleById });
    const goalOptions = goals.map((g) => ({ name: g.name, samples: g.ids.map((id) => byId.get(id).title) }));
    const existingGroups = [...new Set(groups.map((g) => g.title).filter(Boolean))];
    const reqs = buildGroupingRequests(sendable, { useCases: s.useCases, existingGroups, goals: goalOptions, settings: s, related });
    const { results, errors: errs } = await runAll(s, reqs, jevOpts);
    jev = parseGroupingResponses(reqs, results);
    if (jev.size) via = 'jev'; else if (errs.length && !errors.length) errors.push(errs[0].message);
  }
  // A leftover Jev placed into a goal joins it directly (even alone; the goal already has tabs).
  const goalByName = new Map(goals.map((g) => [g.name.toLowerCase(), g]));
  for (const t of rest) {
    const pick = jev.get(t.id);
    const goal = pick?.name && goalByName.get(pick.name.toLowerCase());
    if (goal && (pick.confidence ?? 0) >= s.minChoiceConfidence) { goal.ids.push(t.id); jev.delete(t.id); inGoal.add(t.id); }
  }
  const plan = planGroups(rest.filter((t) => !inGoal.has(t.id)), {
    jev, learned: ctx.state.learned, edges, pairs: ctx.state.pairs, now, halfLifeMs: ctx.hl(),
    minChoiceConfidence: s.minChoiceConfidence, useCases: s.useCases, existingColors,
    siteSignals: s.groupingMode !== 'goals', minSize: 2,
  });

  const planned = [];
  for (const pg of plan.groups) {
    const goal = goalByName.get(pg.name.toLowerCase());
    if (goal) goal.ids.push(...pg.tabIds); else planned.push({ ...pg, kind: 'useCase' });
  }
  for (const g of goals) planned.unshift({ name: g.name, tabIds: g.ids, color: existingColors[g.name.toLowerCase()] || hashColor(g.name), kind: 'goal' });

  // Use-case evidence for learning only counts use-case groups; goals are ephemeral.
  const useCaseNames = new Set(s.useCases.map((u) => u.name.toLowerCase()));
  const ucAssign = new Map([...plan.assign].filter(([, a]) => useCaseNames.has(a.name.toLowerCase())));
  ctx.state.useCaseStats = recordAssignments(ctx.state.useCaseStats, ucAssign, (id) => siteKey(byId.get(id)?.url || ''), now);

  const applied = await applyGroups(ctx, planned, byId, groups);
  for (const g of planned) {
    if (!ctx.state.managedGroups.some((n) => n.toLowerCase() === g.name.toLowerCase())) ctx.state.managedGroups.push(g.name);
    if (g.kind === 'useCase') for (const id of g.tabIds) if (byId.has(id)) ctx.state.learned[siteKey(byId.get(id).url)] = { name: g.name, t: now };
  }
  ctx.saveSoon();
  return {
    groups: applied, via, mode: s.groupingMode, error: errors[0] || null,
    goals: goals.map((g) => ({ name: g.name, count: g.ids.length, via: g.via, pass: g.pass, p: g.p ?? null, cohesion: +g.cohesion.toFixed(2) })),
    coverage: { candidates: candidates.length, grouped: applied.reduce((a, g) => a + g.count, 0) },
  };
}

/**
 * One-time rebuild: snapshot the current groups, ungroup Tab Land's own groups (and, if asked, the
 * user's too), then group everything from scratch in the current mode. Undo restores the snapshot.
 */
export async function regroupAll(ctx, { includeManual = false } = {}) {
  await ctx.ready();
  await ctx.refreshSettings();
  const { chrome } = ctx;
  const managed = new Set(ctx.state.managedGroups.map((n) => n.toLowerCase()));
  const groups = await chrome.tabGroups.query({});
  const tabs = await chrome.tabs.query({});
  const targets = groups.filter((g) => includeManual || managed.has((g.title || '').toLowerCase()));
  const snapshot = targets.map((g) => ({
    title: g.title || '', color: g.color, collapsed: !!g.collapsed, windowId: g.windowId, managed: managed.has((g.title || '').toLowerCase()),
    tabs: tabs.filter((t) => t.groupId === g.id).sort((a, b) => a.index - b.index).map((t) => ({ id: t.id, url: t.url || '' })),
  })).filter((g) => g.tabs.length);
  await chrome.storage.local.set({ regroupUndo: { at: ctx.now(), mode: ctx.settings.groupingMode, groups: snapshot } });

  const ids = snapshot.flatMap((g) => g.tabs.map((t) => t.id));
  let ungrouped = 0;
  for (const id of ids) {
    try { await withRetry(() => chrome.tabs.ungroup(id), { timers: ctx.timers }); ungrouped++; }
    catch (e) { if (!isMissingTabError(e)) throw e; }
  }
  // Old names are no longer "ours": a goal must earn its name from its own tabs.
  const old = new Set(snapshot.map((g) => g.title.toLowerCase()));
  ctx.state.managedGroups = ctx.state.managedGroups.filter((n) => !old.has(n.toLowerCase()));
  const r = await groupTabs(ctx);
  return { ...r, ungrouped, regrouped: snapshot.length, canUndo: snapshot.length > 0 };
}

/** Put the groups back the way they were before the last regroup. Tabs closed since are skipped. */
export async function undoRegroup(ctx) {
  await ctx.ready();
  const { chrome } = ctx;
  const { regroupUndo } = await chrome.storage.local.get('regroupUndo');
  if (!regroupUndo?.groups?.length) return { restored: 0 };
  const live = await chrome.tabs.query({});
  const byId = new Map(live.map((t) => [t.id, t]));
  const used = new Set();
  const find = (t) => {
    const same = byId.get(t.id);
    if (same && same.url === t.url && !used.has(same.id)) return same;
    return live.find((x) => x.url === t.url && !used.has(x.id)) || null;
  };
  // Release every tab we're about to place from whatever Tab Land group it's in now.
  const managed = new Set(ctx.state.managedGroups.map((n) => n.toLowerCase()));
  const titleById = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title || '']));
  let restored = 0;
  for (const g of regroupUndo.groups) {
    const members = g.tabs.map(find).filter(Boolean);
    members.forEach((m) => used.add(m.id));
    // Never pull a tab out of a group the user made since the regroup.
    const free = members.filter((m) => m.groupId < 0 || managed.has((titleById.get(m.groupId) || '').toLowerCase()));
    if (!free.length) continue;
    try {
      const windowId = free.some((m) => m.windowId === g.windowId) ? g.windowId : free[0].windowId;
      const ids = free.filter((m) => m.windowId === windowId).map((m) => m.id);
      const gid = await withRetry(() => chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }), { timers: ctx.timers });
      await chrome.tabGroups.update(gid, { title: g.title, color: g.color, collapsed: g.collapsed });
      if (g.managed && g.title && !ctx.state.managedGroups.some((n) => n.toLowerCase() === g.title.toLowerCase())) ctx.state.managedGroups.push(g.title);
      restored++;
    } catch (e) {
      if (!isMissingTabError(e)) throw e;
      ctx.log(e, 'undoRegroup');
    }
  }
  await chrome.storage.local.remove('regroupUndo');
  ctx.saveSoon();
  return { restored };
}

/** Last resort: the first two meaningful words of the most-used member's title. */
function fallbackGoalName(tabs) {
  const t = tabs.find((x) => x.title) || tabs[0];
  const words = String(t?.title || 'Goal').split(/[\s\-|·—–:]+/).filter((w) => w.length > 2).slice(0, 3).join(' ');
  return (words || 'Goal').slice(0, 24);
}

function dedupeNames(goals) {
  const seen = new Map();
  for (const g of goals) {
    const k = g.name.toLowerCase();
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 1) g.name = `${g.name} ${n}`;
  }
  return goals;
}

/** Create or extend groups window by window, re-checking that every tab still exists. */
export async function applyGroups(ctx, planned, byId, groups) {
  const { chrome } = ctx;
  const live = new Map((await chrome.tabs.query({})).map((t) => [t.id, t]));
  const applied = [];
  for (const g of planned) {
    const perWindow = new Map();
    for (const id of g.tabIds) {
      const t = live.get(id);
      if (!t || t.pinned || !byId.has(id)) continue; // closed or pinned since we planned
      if (!perWindow.has(t.windowId)) perWindow.set(t.windowId, []);
      perWindow.get(t.windowId).push(t);
    }
    for (const [windowId, list] of perWindow) {
      const existing = groups.find((x) => x.windowId === windowId && (x.title || '').toLowerCase() === g.name.toLowerCase());
      if (!existing && list.length < 2) continue;
      const ids = list.filter((t) => t.groupId !== existing?.id).map((t) => t.id);
      try {
        if (ids.length && existing) {
          await withRetry(() => chrome.tabs.group({ groupId: existing.id, tabIds: ids }), { timers: ctx.timers });
        } else if (ids.length) {
          const gid = await withRetry(() => chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }), { timers: ctx.timers });
          await chrome.tabGroups.update(gid, { title: g.name, color: g.color || hashColor(g.name), collapsed: false });
        }
        applied.push({ name: g.name, count: list.length, windowId, kind: g.kind || 'useCase' });
      } catch (e) {
        if (!isMissingTabError(e)) throw e;
        ctx.log(e, 'applyGroups');
      }
    }
  }
  return applied;
}
