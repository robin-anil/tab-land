// Persistent state: versioned schema, migrations, bounded sizes, quota recovery.
//   storage.local   — durable learning (usage, co-usage, lineage, use-case evidence, undo)
//   storage.session — per-tab metadata for this browser session (tab ids aren't stable across restarts)
import { pruneMap } from '../lib/scoring.js';
import { keepNewest, isQuotaError } from './util.js';

export const SCHEMA = 2;
export const LOCAL_KEYS = ['schema', 'usage', 'pairs', 'tabPairs', 'urlLineage', 'learned', 'managedGroups', 'closedBatches', 'lastRun', 'useCaseStats'];
export const SESSION_KEYS = ['meta', 'lastActive', 'linkEdges'];
export const LIMITS = { urls: 5000, sites: 1500, pairs: 4000, tabPairs: 4000, lineage: 4000, learned: 1500, batches: 10, managed: 200 };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function emptyState() {
  return {
    schema: SCHEMA,
    meta: {}, lastActive: null, linkEdges: {},
    usage: { urls: {}, sites: {} }, pairs: {}, tabPairs: {}, urlLineage: {}, learned: {},
    managedGroups: [], closedBatches: [], lastRun: null, useCaseStats: {},
    errors: [],
  };
}

/**
 * Bring whatever is in storage up to the current schema. Unknown or corrupt values are replaced,
 * never trusted: a bad write from an older build must not crash the worker.
 */
export function migrate(loc = {}, ses = {}) {
  const s = emptyState();
  const from = Number(loc.schema) || 1;
  if (isObj(loc.usage)) s.usage = { urls: isObj(loc.usage.urls) ? loc.usage.urls : {}, sites: isObj(loc.usage.sites) ? loc.usage.sites : {} };
  if (isObj(loc.pairs)) s.pairs = loc.pairs;
  if (isObj(loc.tabPairs)) s.tabPairs = loc.tabPairs;
  if (isObj(loc.urlLineage)) {
    // v1 stored lineage as {child: "parentKey"}; v2 stores {child: {p, t}}.
    for (const [k, v] of Object.entries(loc.urlLineage)) {
      if (typeof v === 'string') s.urlLineage[k] = { p: v, t: 0 };
      else if (isObj(v) && typeof v.p === 'string') s.urlLineage[k] = v;
    }
  }
  if (isObj(loc.learned)) s.learned = loc.learned;
  if (Array.isArray(loc.managedGroups)) s.managedGroups = loc.managedGroups.filter((x) => typeof x === 'string');
  if (Array.isArray(loc.closedBatches)) s.closedBatches = loc.closedBatches.filter((b) => isObj(b) && Array.isArray(b.tabs));
  if (isObj(loc.lastRun)) s.lastRun = loc.lastRun;
  if (isObj(loc.useCaseStats)) s.useCaseStats = loc.useCaseStats;
  if (isObj(ses.meta)) s.meta = ses.meta;
  if (isObj(ses.lastActive)) s.lastActive = ses.lastActive;
  if (isObj(ses.linkEdges)) s.linkEdges = ses.linkEdges;
  s.migratedFrom = from < SCHEMA ? from : null;
  return s;
}

/** Shrink everything to its limits (or a fraction of them under quota pressure). */
export function bound(state, now, halfLifeMs, factor = 1) {
  // Normally cap at the limits; under quota pressure (factor < 1) shrink relative to what's actually there.
  const L = (limit, map) => (factor >= 1 ? limit : Math.max(10, Math.floor(Math.min(limit, Object.keys(map).length) * factor)));
  state.usage.urls = pruneMap(state.usage.urls, L(LIMITS.urls, state.usage.urls), now, halfLifeMs);
  state.usage.sites = pruneMap(state.usage.sites, L(LIMITS.sites, state.usage.sites), now, halfLifeMs);
  state.pairs = pruneMap(state.pairs, L(LIMITS.pairs, state.pairs), now, halfLifeMs);
  state.tabPairs = pruneMap(state.tabPairs, L(LIMITS.tabPairs, state.tabPairs), now, halfLifeMs);
  state.urlLineage = keepNewest(state.urlLineage, L(LIMITS.lineage, state.urlLineage));
  state.learned = keepNewest(state.learned, L(LIMITS.learned, state.learned));
  state.closedBatches = state.closedBatches.slice(0, Math.max(1, Math.floor(LIMITS.batches * factor)));
  state.managedGroups = state.managedGroups.slice(-LIMITS.managed);
  return state;
}

export async function loadState(chrome) {
  const [loc, ses] = await Promise.all([chrome.storage.local.get(LOCAL_KEYS), chrome.storage.session.get(SESSION_KEYS)]);
  return migrate(loc, ses);
}

/**
 * Write state. On a quota error, prune to a quarter of the limits and retry once; if storage is still
 * full, keep running in memory and report it rather than throwing out of a listener.
 */
export async function persistState(chrome, state, { now, halfLifeMs, log }) {
  bound(state, now, halfLifeMs);
  const local = {
    schema: SCHEMA, usage: state.usage, pairs: state.pairs, tabPairs: state.tabPairs, urlLineage: state.urlLineage,
    learned: state.learned, managedGroups: state.managedGroups, closedBatches: state.closedBatches,
    lastRun: state.lastRun, useCaseStats: state.useCaseStats,
  };
  const session = { meta: state.meta, lastActive: state.lastActive, linkEdges: state.linkEdges };
  const write = async () => Promise.all([chrome.storage.local.set(local), chrome.storage.session.set(session)]);
  try {
    await write();
    return { ok: true };
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    bound(state, now, halfLifeMs, 0.25);
    Object.assign(local, {
      usage: state.usage, pairs: state.pairs, tabPairs: state.tabPairs, urlLineage: state.urlLineage,
      learned: state.learned, closedBatches: state.closedBatches,
    });
    try {
      await write();
      log?.(new Error('Storage was full; pruned learned data to a quarter of its size'), 'store');
      return { ok: true, pruned: true };
    } catch (e2) {
      log?.(e2, 'store');
      return { ok: false, error: e2.message };
    }
  }
}
