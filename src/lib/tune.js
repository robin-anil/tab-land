// Tuning: try grouping settings on a real tab export and let Jev judge the results.
// Pure (fetch is injected) so it can be tested; scripts/tune.mjs is the command-line wrapper.
// Nothing here returns titles or URLs: results are numbers only.
import { goalGraph, iterativeGoals, ITERATIVE } from './goals.js';
import { buildLineage } from './lineage.js';
import { hostOf, isWebUrl, matchesDomain } from './url.js';
import { DAY } from './scoring.js';
import { runAll, buildGoalRequests, parseGoalResponses, buildGroupingRequests, parseGroupingResponses } from './jev.js';
import { sanitizeSettings } from './settings.js';

export const QUICK_GRID = [];
for (const strict of [0.25, 0.3, 0.35]) for (const attach of [0.1, 0.15, 0.2]) QUICK_GRID.push({ strict, attach, loose: ITERATIVE.loose });
export const FULL_GRID = [];
for (const strict of [0.22, 0.26, 0.3, 0.34, 0.38]) for (const attach of [0.08, 0.12, 0.15, 0.2, 0.25]) for (const loose of [0.14, 0.18, 0.24]) FULL_GRID.push({ strict, attach, loose });

/** Turn an export into what the grouping code sees. */
export function prepare(exp) {
  const settings = sanitizeSettings({ ...exp.settings });
  const tabs = (exp.tabs || []).filter((t) => isWebUrl(t.url) && !t.pinned);
  const edges = buildLineage(tabs, { urlLineage: exp.urlLineage || {} });
  const graph = goalGraph(tabs, { edges, tabPairs: exp.tabPairs || {}, now: exp.exportedAt || Date.now(), halfLifeMs: (settings.halfLifeDays || 3) * DAY });
  const allowed = (t) => !matchesDomain(hostOf(t.url), settings.aiExcludedDomains);
  return { settings, tabs, graph, byId: new Map(tabs.map((t) => [t.id, t])), allowed, useCases: exp.useCases || settings.useCases };
}

/**
 * Jev as the judge, cached by goal membership so repeated configs don't re-ask:
 *   agreement — for each goal, Jev's mean probability that each tab belongs (goal p for pairs)
 *   missed    — loose tabs Jev confidently places into one of the goals (should have been grouped)
 */
/** @param {any} prep @param {{ apiKey?: string, fetchImpl?: any, retryDelay?: number, cache?: any }} [opts] */
export function judge(prep, { apiKey, fetchImpl, retryDelay, cache = null } = {}) {
  // `cache` ({ goals: {key: p}, missed: {key: n} }) can be saved between runs; keys are tab ids, values numbers.
  const store = cache || { goals: {}, missed: {} };
  store.goals ||= {}; store.missed ||= {};
  const goalCache = { has: (k) => k in store.goals, get: (k) => store.goals[k], set: (k, v) => { store.goals[k] = v; } };
  const settings = { ...prep.settings, jevApiKey: apiKey };
  const opts = { fetchImpl, retryDelay, concurrency: 4 };
  let calls = 0, errors = 0;
  const kinds = {};
  const tally = (errs) => { for (const e of errs) { const k = e?.status ? `http ${e.status}` : e?.name === 'AbortError' || /timed out/i.test(e?.message || '') ? 'timeout' : e?.status === 0 ? 'network' : 'error'; kinds[k] = (kinds[k] || 0) + 1; } };

  async function goalAgreement(goals) {
    const todo = goals.filter((g) => !goalCache.has(g.key));
    if (todo.length) {
      const reqs = buildGoalRequests(todo.map((g) => ({ tabs: g.tabs })), { settings });
      const { results, errors: errs } = await runAll(settings, reqs, opts);
      calls += reqs.length; errors += errs.length; tally(errs);
      parseGoalResponses(reqs, results).forEach((a, i) => {
        if (!a) return;
        const ps = [...a.members.values()];
        goalCache.set(todo[i].key, ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : a.p ?? null);
      });
    }
    let w = 0, sum = 0;
    for (const g of goals) { const p = goalCache.get(g.key); if (p != null) { sum += p * g.tabs.length; w += g.tabs.length; } }
    return w ? sum / w : null;
  }

  async function missed(goals, loose) {
    if (!loose.length || !goals.length) return { missed: 0, judged: 0 };
    const mkey = goals.map((g) => g.key).join('|') + '#' + loose.map((t) => t.id).sort((a, b) => a - b).join(',');
    if (mkey in store.missed) return store.missed[mkey];
    const goalOptions = goals.map((g, i) => ({ name: `Goal ${i + 1}`, samples: g.tabs.map((t) => t.title) }));
    const reqs = buildGroupingRequests(loose, { useCases: [], goals: goalOptions, settings, existingGroups: [] });
    const { results, errors: errs } = await runAll(settings, reqs, opts);
    calls += reqs.length; errors += errs.length; tally(errs);
    const picks = parseGroupingResponses(reqs, results);
    let n = 0;
    for (const v of picks.values()) if (v.name && v.name.startsWith('Goal ') && (v.confidence ?? 0) >= 0.6) n++;
    const out = { missed: n, judged: picks.size };
    if (!errs.length) store.missed[mkey] = out;
    return out;
  }

  return { goalAgreement, missed, cache: store, stats: () => ({ calls, errors, kinds }) };
}

/** Run one config: group, then (optionally) have Jev judge it. Numbers only. */
export async function evaluate(prep, cfg, judgeFns = null) {
  const ids = prep.tabs.map((t) => t.id);
  const raw = iterativeGoals(ids, prep.graph, cfg);
  const goals = raw.map((g) => {
    const tabs = g.ids.map((id) => prep.byId.get(id)).filter(prep.allowed);
    return { ...g, tabs, key: [...g.ids].sort((a, b) => a - b).join(',') };
  }).filter((g) => g.tabs.length >= 2);
  const grouped = new Set(raw.flatMap((g) => g.ids));
  const out = {
    ...cfg,
    tabs: ids.length,
    groups: raw.length,
    grouped: grouped.size,
    coverage: ids.length ? grouped.size / ids.length : 0,
    byPass: raw.reduce((m, g) => ((m[g.pass] = (m[g.pass] || 0) + g.ids.length), m), {}),
    largest: Math.max(0, ...raw.map((g) => g.ids.length)),
    singletonsLeft: ids.length - grouped.size,
  };
  if (judgeFns) {
    out.agreement = await judgeFns.goalAgreement(goals);
    const loose = prep.tabs.filter((t) => !grouped.has(t.id) && prep.allowed(t));
    const m = await judgeFns.missed(goals, loose);
    out.missed = m.missed;
    out.missedRate = ids.length ? m.missed / ids.length : 0;
  }
  // Higher is better: cover tabs, keep Jev agreeing, don't leave tabs Jev thinks belong.
  const agree = out.agreement ?? 1;
  out.score = +(out.coverage * agree - 0.5 * (out.missedRate || 0)).toFixed(4);
  return out;
}

/** @param {any} exp @param {{ grid?: any[], apiKey?: string|null, fetchImpl?: any, retryDelay?: number, cache?: any, onProgress?: (i: number, n: number) => void }} [opts] */
export async function tune(exp, { grid = QUICK_GRID, apiKey = null, fetchImpl = undefined, retryDelay = undefined, cache = null, onProgress = () => {} } = {}) {
  const prep = prepare(exp);
  const j = apiKey ? judge(prep, { apiKey, fetchImpl, retryDelay, cache }) : null;
  const strictOnly = await evaluate(prep, { strict: ITERATIVE.strict, attach: 9, loose: 9 }, j);
  const current = await evaluate(prep, { ...ITERATIVE, strict: prep.settings.goalThreshold }, j);
  const results = [];
  for (const [i, cfg] of grid.entries()) { results.push(await evaluate(prep, cfg, j)); onProgress(i + 1, grid.length); }
  results.sort((a, b) => b.score - a.score);
  return { tabs: prep.tabs.length, strictOnly, current, best: results[0], results, jev: j ? j.stats() : null };
}
