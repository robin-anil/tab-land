// Small resilience helpers shared by the background modules.

export const sleep = (ms, timers = globalThis) => new Promise((r) => timers.setTimeout(r, ms));

/** Chrome rejects tab edits while the user drags a tab; retry those, rethrow anything else. */
export async function withRetry(fn, { tries = 4, delay = 250, timers = globalThis } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries - 1 || !/cannot be edited|dragging/i.test(String(e?.message))) throw e;
      await sleep(delay * (i + 1), timers);
    }
  }
}

/**
 * A single-lane queue for actions that mutate tabs. Two tidies, or a tidy and an alarm,
 * never interleave. `skipIfBusy` lets background jobs bow out instead of piling up.
 */
export function serial() {
  let tail = Promise.resolve();
  let running = 0;
  const run = (fn, { skipIfBusy = false } = {}) => {
    if (skipIfBusy && running) return Promise.resolve({ skipped: true, reason: 'busy' });
    running++;
    const next = tail.then(fn, fn);
    tail = next.then(() => {}, () => {}).finally(() => { running--; });
    return next;
  };
  run.busy = () => running > 0;
  return run;
}

/** Wrap an event listener so one bad event can't throw out of the service worker. */
export function guard(name, fn, log) {
  return (...args) => {
    try {
      const r = fn(...args);
      // Hand back a promise that never rejects: an async failure is logged, not left unhandled.
      if (r && typeof r.then === 'function') return r.catch((e) => { log(e, name); });
      return r;
    } catch (e) {
      log(e, name);
      return undefined;
    }
  };
}

export const isQuotaError = (e) => /quota/i.test(String(e?.message));
export const isMissingTabError = (e) => /no tab with id|invalid tab id|no group with id/i.test(String(e?.message));

/**
 * Remove tabs that may have vanished meanwhile. Chrome rejects the whole batch if one id is gone,
 * so fall back to one-by-one. Returns the ids actually removed.
 */
export async function safeRemove(chrome, ids, timers) {
  if (!ids.length) return [];
  const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const todo = ids.filter((id) => live.has(id));
  if (!todo.length) return [];
  try {
    await withRetry(() => chrome.tabs.remove(todo), { timers });
    return todo;
  } catch (e) {
    if (!isMissingTabError(e)) throw e;
    const done = [];
    for (const id of todo) {
      try { await withRetry(() => chrome.tabs.remove(id), { timers }); done.push(id); }
      catch (err) { if (!isMissingTabError(err)) throw err; }
    }
    return done;
  }
}

/** Keep the newest N entries of a {key: {t}} map. */
export function keepNewest(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const out = {};
  keys.sort((a, b) => (map[b]?.t || 0) - (map[a]?.t || 0)).slice(0, max).forEach((k) => (out[k] = map[k]));
  return out;
}

/** Bounded ring buffer for diagnostics. */
export function pushRing(list, item, max = 50) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}
