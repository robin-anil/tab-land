// Cleanup: plan (duplicates + closable children, Jev-reviewed), close with revalidation, undo, reorder, tidy.
import { normalizeUrl, isWebUrl } from '../lib/url.js';
import { tabScore } from '../lib/scoring.js';
import { buildLineage, ROOT_TRANSITIONS } from '../lib/lineage.js';
import { findExactDuplicates, findClosableChildren, findPageVariants, formatIdle } from '../lib/dedupe.js';
import { planWindowOrder } from '../lib/reorder.js';
import { runAll, buildCloseReviewRequests, parseNoulResponses, blendConfidence } from '../lib/jev.js';
import { snapshot, groupTitleMap } from './context.js';
import { withRetry, safeRemove, isMissingTabError } from './util.js';

export async function computePlan(ctx, { withJev = true } = {}) {
  await ctx.ready();
  await ctx.refreshSettings();
  const now = ctx.now();
  const tabs = (await snapshot(ctx)).filter((t) => !t.url.startsWith(ctx.ownPrefix()));
  const scoreOf = (t) => tabScore(t, ctx.state.usage, now, ctx.hl());
  if (ctx.settings.linkInference) await inferLinks(ctx, tabs).catch((e) => ctx.log(e, 'inferLinks'));
  const edges = buildLineage(tabs, { urlLineage: ctx.state.urlLineage, linkEdges: ctx.state.linkEdges });
  const duplicates = findExactDuplicates(tabs, { crossWindow: ctx.settings.crossWindowDedupe, scoreOf, isProtected: ctx.isProtected });
  const dupIds = new Set(duplicates.flatMap((d) => d.close.map((t) => t.id)));
  // Versions of the same page are details of one master (master/detail model, like child tabs).
  const variants = ctx.settings.closeVariants
    ? findPageVariants(tabs, { crossWindow: ctx.settings.crossWindowDedupe, now, idleMinutes: ctx.settings.dupIdleMinutes, scoreOf, isProtected: ctx.isProtected, exclude: dupIds })
    : [];
  const handled = new Set([...dupIds, ...variants.map((v) => v.tab.id)]);
  let children = findClosableChildren(tabs, edges, {
    now, staleMinutes: ctx.settings.staleMinutes, transientMinutes: ctx.settings.transientMinutes,
    scoreOf, isProtected: ctx.isProtected, exclude: handled,
  });
  let jevError = null;
  if (withJev && ctx.settings.jevApiKey && ctx.settings.useJevForClosing && children.length) {
    try { children = await reviewWithJev(ctx, children, now); } catch (e) { jevError = e.message; }
  }
  children = [...variants, ...children];
  return { tabs, edges, duplicates, children, scoreOf, jevError, now };
}

async function reviewWithJev(ctx, children, now) {
  const cache = ctx.jevCache;
  const todo = children
    .filter((c) => ctx.aiAllowed(c.tab) && (!c.parent || ctx.aiAllowed(c.parent)) && c.signals?.via !== 'transient' && c.signals?.via !== 'variant')
    .filter((c) => { const hit = cache.get(c.tab.id); return !hit || hit.url !== c.tab.url || now - hit.at > 30 * 60e3; })
    .slice(0, 60);
  if (todo.length) {
    const reqs = buildCloseReviewRequests(todo, { settings: ctx.settings });
    const { results, errors } = await runAll(ctx.settings, reqs, { fetchImpl: ctx.fetch, retryDelay: ctx.jevRetryDelay });
    const probs = parseNoulResponses(reqs, results);
    for (const c of todo) if (probs.has(c.tab.id)) cache.set(c.tab.id, { p: probs.get(c.tab.id), at: now, url: c.tab.url });
    if (errors.length && !probs.size) throw errors[0];
  }
  return children.map((c) => {
    const hit = cache.get(c.tab.id);
    if (!hit || hit.url !== c.tab.url) return c;
    return { ...c, heuristic: c.confidence, jev: hit.p, confidence: blendConfidence(c.confidence, hit.p) };
  }).sort((a, b) => b.confidence - a.confidence);
}

/** Optional: does a candidate parent page link to a child? Runs in the page; nothing leaves the browser. */
async function inferLinks(ctx, tabs) {
  const { chrome } = ctx;
  if (!chrome.scripting || !(await chrome.permissions.contains({ permissions: ['scripting'], origins: ['<all_urls>'] }))) return;
  const orphans = tabs.filter((t) => isWebUrl(t.url) && t.parentTabId == null && ctx.state.linkEdges[t.id] == null && !ROOT_TRANSITIONS.has(t.startTransition));
  if (!orphans.length) return;
  const targets = [...new Set(orphans.map((t) => t.url.split('#')[0]))];
  const parents = tabs.filter((t) => isWebUrl(t.url) && !t.discarded).slice(0, 40);
  await Promise.all(parents.map(async (p) => {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: p.id },
        func: (want) => {
          const set = new Set(want);
          const found = new Set();
          for (const a of document.querySelectorAll('a[href]')) { const h = /** @type {HTMLAnchorElement} */ (a).href.split('#')[0]; if (set.has(h)) found.add(h); }
          return [...found];
        },
        args: [targets],
      });
      for (const href of res?.result || []) {
        for (const o of orphans) {
          if (o.id !== p.id && o.url.split('#')[0] === href && (p.openedAt ?? 0) <= (o.openedAt ?? Infinity) && ctx.state.linkEdges[o.id] == null) ctx.state.linkEdges[o.id] = p.id;
        }
      }
    } catch { /* restricted or discarded page */ }
  }));
  ctx.saveSoon();
}

const publicTab = (t, scoreOf) => t && {
  id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl,
  score: scoreOf ? +scoreOf(t).toFixed(2) : undefined,
};

export async function publicPlan(ctx) {
  const p = await computePlan(ctx);
  const windows = new Set(p.tabs.map((t) => t.windowId));
  return {
    stats: { tabs: p.tabs.length, windows: windows.size, groups: new Set(p.tabs.filter((t) => t.groupId >= 0).map((t) => t.groupId)).size },
    duplicates: p.duplicates.map((d) => ({ keep: publicTab(d.keep), close: d.close.map((t) => publicTab(t)) })),
    children: p.children.map((/** @type {any} */ c) => ({
      tab: publicTab(c.tab), parent: publicTab(c.parent), reason: c.reason, via: c.signals?.via,
      confidence: +c.confidence.toFixed(2), jev: c.jev != null ? +c.jev.toFixed(2) : null, idle: formatIdle(c.idleMin),
    })),
    autoCloseConfidence: ctx.settings.autoCloseConfidence,
    groupingMode: ctx.settings.groupingMode,
    hasKey: !!ctx.settings.jevApiKey,
    jevError: p.jevError,
    canUndo: ctx.state.closedBatches.length > 0,
    lastRun: ctx.state.lastRun,
  };
}

/**
 * Close tabs, re-checking each one first: a tab that became active, pinned, audible or protected,
 * or navigated away from the URL that was planned, is skipped. Items are ids or {id, url}.
 */
export async function closeTabs(ctx, items, label = 'Manual') {
  await ctx.ready();
  const { chrome } = ctx;
  const wanted = new Map();
  for (const it of items || []) {
    const id = typeof it === 'object' && it ? Number(it.id) : Number(it);
    if (Number.isInteger(id)) wanted.set(id, typeof it === 'object' && it?.url ? normalizeUrl(it.url) : null);
  }
  if (!wanted.size) return { closed: 0, skipped: [] };
  const all = await chrome.tabs.query({});
  const skipped = [];
  const tabs = [];
  for (const [id, url] of wanted) {
    const t = all.find((x) => x.id === id);
    if (!t) { skipped.push({ id, reason: 'already closed' }); continue; }
    const why = t.pinned ? 'pinned' : t.active ? 'now active' : t.audible ? 'playing audio'
      : ctx.isProtected({ url: t.url || '' }) ? 'protected'
        : url && normalizeUrl(t.url || '') !== url ? 'navigated since' : null;
    if (why) skipped.push({ id, reason: why }); else tabs.push(t);
  }
  if (!tabs.length) return { closed: 0, skipped };

  const groupTitles = await groupTitleMap(ctx);
  ctx.state.closedBatches = [{
    at: ctx.now(), label,
    tabs: tabs.filter((t) => !t.incognito).map((t) => ({ url: t.url, title: t.title, windowId: t.windowId, index: t.index, groupTitle: groupTitles.get(t.groupId) || null })),
  }, ...ctx.state.closedBatches].slice(0, 10);

  // A closed duplicate's children move to the surviving copy so lineage isn't lost.
  const closing = new Set(tabs.map((t) => t.id));
  const survivors = new Map();
  for (const t of all) if (!closing.has(t.id) && t.url) survivors.set(normalizeUrl(t.url), t.id);
  for (const t of tabs) {
    const keeper = survivors.get(normalizeUrl(t.url || ''));
    if (keeper == null) continue;
    for (const m of Object.values(ctx.state.meta)) if (m.parentTabId === t.id) m.parentTabId = keeper;
  }
  const removed = await safeRemove(chrome, tabs.map((t) => t.id), ctx.timers);
  for (const t of tabs) if (!removed.includes(t.id)) skipped.push({ id: t.id, reason: 'already closed' });
  ctx.saveSoon();
  return { closed: removed.length, skipped };
}

export async function undoLast(ctx) {
  await ctx.ready();
  const { chrome } = ctx;
  const batch = ctx.state.closedBatches.shift();
  if (!batch) return { reopened: 0 };
  const windows = new Set((await chrome.windows.getAll({ windowTypes: ['normal'] })).map((w) => w.id));
  let fallback = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null))?.id;
  if (fallback == null && !windows.size) fallback = (await chrome.windows.create({})).id;
  let reopened = 0;
  for (const t of [...batch.tabs].sort((a, b) => a.index - b.index)) {
    const windowId = windows.has(t.windowId) ? t.windowId : fallback;
    try {
      const created = await chrome.tabs.create({ url: t.url, windowId, index: t.index, active: false });
      reopened++;
      if (t.groupTitle) {
        const [g] = await chrome.tabGroups.query({ windowId: created.windowId, title: t.groupTitle });
        if (g) await withRetry(() => chrome.tabs.group({ groupId: g.id, tabIds: [created.id] }), { timers: ctx.timers }).catch(() => {});
      }
    } catch (e) { ctx.log(e, 'undo'); }
  }
  ctx.saveSoon();
  return { reopened };
}

/** Order each window by usage. A tab or group that vanishes mid-way is skipped, not fatal. */
export async function reorderAll(ctx) {
  await ctx.ready();
  await ctx.refreshSettings();
  const { chrome } = ctx;
  const now = ctx.now();
  const tabs = await snapshot(ctx);
  const scoreOf = (t) => (ctx.isProtected(t) ? -1 : tabScore(t, ctx.state.usage, now, ctx.hl()));
  const byWindow = new Map();
  for (const t of tabs) {
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }
  let moved = 0;
  const tolerate = async (fn) => {
    try { await withRetry(fn, { timers: ctx.timers }); return true; }
    catch (e) { if (isMissingTabError(e)) return false; throw e; }
  };
  for (const [, wtabs] of byWindow) {
    const lastUsed = (t) => (ctx.isProtected(t) ? 0 : Math.max(t.lastActivated || 0, t.lastAccessed || 0));
    const plan = planWindowOrder(wtabs, scoreOf, { groupsAsUnits: ctx.settings.reorderGroupsAsBlocks, order: ctx.settings.groupOrder, lastUsed });
    if (!plan.changed) continue;
    for (const u of plan.units) {
      if (u.type !== 'group') continue;
      const start = Math.min(...wtabs.filter((t) => t.groupId === u.groupId).map((t) => t.index));
      for (let i = 0; i < u.tabIds.length; i++) await tolerate(() => chrome.tabs.move(u.tabIds[i], { index: start + i }));
    }
    let index = plan.startIndex;
    for (const u of plan.units) {
      const ok = u.type === 'group'
        ? await tolerate(() => chrome.tabGroups.move(u.groupId, { index }))
        : await tolerate(() => chrome.tabs.move(u.tabId, { index }));
      if (ok) { index += u.type === 'group' ? u.tabIds.length : 1; moved++; }
    }
  }
  return { moved, order: ctx.settings.groupOrder };
}

/**
 * Background sweep: close extra copies and page versions that have sat unused for dupIdleMinutes.
 * The copy in use (or used last) always stays. Undo brings anything back.
 */
export async function sweepDuplicates(ctx) {
  await ctx.ready();
  const s = await ctx.refreshSettings();
  if (!s.autoCloseDuplicates) return { closed: 0, skipped: true };
  const p = await computePlan(ctx, { withJev: false });
  const idleOk = (t) => (p.now - Math.max(t.lastActivated || 0, t.lastAccessed || 0, t.openedAt || 0)) / 60e3 >= s.dupIdleMinutes;
  const items = [
    ...p.duplicates.flatMap((d) => d.close.filter(idleOk)),
    ...p.children.filter((c) => c.signals?.via === 'variant').map((c) => c.tab),
  ].map((t) => ({ id: t.id, url: t.url }));
  if (!items.length) return { closed: 0 };
  const r = await closeTabs(ctx, items, 'Auto: extra copies');
  return { closed: r.closed };
}

/** The full pass. Automatic runs only close high-confidence children. */
export async function tidy(ctx, { auto = false, closeIds = null, steps = null } = {}, { groupTabs }) {
  await ctx.ready();
  await ctx.refreshSettings();
  const s = ctx.settings;
  const want = steps || { dedupe: !auto || s.autoDedupe, children: !auto || s.autoCloseChildren, group: !auto || s.autoGroup, reorder: !auto || s.autoReorder };
  const report = { closed: 0, skipped: 0, groups: [], moved: 0, errors: [], via: undefined };
  try {
    if (closeIds) {
      const r = await closeTabs(ctx, closeIds, 'Tidy');
      report.closed += r.closed; report.skipped += r.skipped.length;
    } else if (want.dedupe || want.children) {
      const p = await computePlan(ctx, { withJev: want.children });
      const items = [];
      if (want.dedupe) items.push(...p.duplicates.flatMap((d) => d.close.map((t) => ({ id: t.id, url: t.url }))));
      if (want.children) items.push(...p.children.filter((c) => c.confidence >= s.autoCloseConfidence).map((c) => ({ id: c.tab.id, url: c.tab.url })));
      if (p.jevError) report.errors.push(p.jevError);
      const r = await closeTabs(ctx, items, auto ? 'Auto-tidy' : 'Tidy');
      report.closed += r.closed; report.skipped += r.skipped.length;
    }
  } catch (e) { report.errors.push(`Closing: ${e.message}`); ctx.log(e, 'tidy.close'); }
  if (want.group) {
    try { const g = await groupTabs(ctx); report.groups = g.groups; report.via = g.via; if (g.error) report.errors.push(g.error); }
    catch (e) { report.errors.push(`Grouping: ${e.message}`); ctx.log(e, 'tidy.group'); }
  }
  if (want.reorder) {
    try { report.moved = (await reorderAll(ctx)).moved; }
    catch (e) { report.errors.push(`Reorder: ${e.message}`); ctx.log(e, 'tidy.reorder'); }
  }
  ctx.state.lastRun = { at: ctx.now(), auto, closed: report.closed, groups: report.groups.length, moved: report.moved, errors: report.errors.length };
  ctx.saveSoon();
  return report;
}
