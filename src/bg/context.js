// The background context: everything a module needs, injected so tests can supply fakes.
import { loadSettings, DEFAULTS } from '../lib/settings.js';
import { DAY } from '../lib/scoring.js';
import { hostOf, isWebUrl, matchesDomain } from '../lib/url.js';
import { loadState, persistState, emptyState } from './store.js';
import { serial, pushRing } from './util.js';

/**
 * @param {{chrome: any, fetch?: Function, now?: () => number, timers?: {setTimeout: Function, clearTimeout: Function}, uuid?: () => string, saveDelayMs?: number, console?: Console}} deps
 */
export function createContext({ chrome, fetch = undefined, now = () => Date.now(), timers = globalThis, uuid = () => crypto.randomUUID(), saveDelayMs = 400, console: con = globalThis.console }) {
  let loading = null;
  let saveTimer = null;

  const ctx = {
    chrome, fetch, now, timers, uuid,
    state: null,
    settings: null,
    jevCache: new Map(), // tabId -> {p, at, url}
    exclusive: serial(),

    /** Load state once per worker lifetime; concurrent callers share the same promise. */
    async ready() {
      if (ctx.state) return ctx.state;
      if (!loading) {
        loading = (async () => {
          try {
            ctx.settings = await loadSettings(chrome.storage.local);
            ctx.state = await loadState(chrome);
          } catch (e) {
            // Storage unreadable: run with empty state rather than not at all.
            ctx.log(e, 'load');
            ctx.settings = ctx.settings || { ...DEFAULTS };
            ctx.state = emptyState();
          }
          await ctx.reconcile();
          return ctx.state;
        })().finally(() => { loading = null; });
      }
      return loading;
    },

    async refreshSettings() {
      ctx.settings = await loadSettings(chrome.storage.local);
      return ctx.settings;
    },

    hl: () => (ctx.settings?.halfLifeDays || 3) * DAY,

    saveSoon() {
      timers.clearTimeout(saveTimer);
      saveTimer = timers.setTimeout(() => { ctx.flush(); }, saveDelayMs);
    },

    async flush() {
      timers.clearTimeout(saveTimer);
      saveTimer = null;
      if (!ctx.state) return { ok: true };
      return persistState(chrome, ctx.state, { now: now(), halfLifeMs: ctx.hl(), log: ctx.log });
    },

    log(err, where = 'unknown') {
      const message = String(err?.message || err);
      try { con?.warn?.(`[Tab Land] ${where}: ${message}`); } catch {}
      if (ctx.state) pushRing(ctx.state.errors, { at: now(), where, message });
    },

    /** Per-tab metadata must match tabs that exist (after a browser restart or worker restart). */
    async reconcile() {
      const tabs = await chrome.tabs.query({});
      const live = new Set(tabs.map((t) => String(t.id)));
      const meta = ctx.state.meta;
      for (const id of Object.keys(meta)) if (!live.has(id)) delete meta[id];
      for (const t of tabs) {
        const m = meta[t.id];
        if (!m) {
          meta[t.id] = {
            openedAt: t.lastAccessed || now(), url: t.url || t.pendingUrl || '',
            parentTabId: t.openerTabId ?? null, via: t.openerTabId != null ? 'opener' : null,
            activations: 0, seeded: true,
          };
        } else if (t.url) {
          m.url = t.url;
        }
      }
      ctx.saveSoon();
    },

    meta(tabId) {
      const meta = ctx.state.meta;
      if (!meta[tabId]) meta[tabId] = { openedAt: now(), url: '', parentTabId: null, activations: 0 };
      return meta[tabId];
    },

    isProtected: (t) => matchesDomain(hostOf(t.url), ctx.settings.protectedDomains),
    /** Whether a tab's title/URL may be sent to Jev. Incognito never is. */
    aiAllowed: (t) => !t.incognito && isWebUrl(t.url) && !matchesDomain(hostOf(t.url), ctx.settings.aiExcludedDomains),
    ownPrefix: () => `chrome-extension://${chrome.runtime.id}/`,
  };
  return ctx;
}

/** A plain view of every normal-window tab joined with what we know about it. */
export async function snapshot(ctx) {
  const tabs = await ctx.chrome.tabs.query({ windowType: 'normal' });
  return tabs.map((t) => {
    const m = ctx.state.meta[t.id] || {};
    return {
      id: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', index: t.index, windowId: t.windowId,
      pinned: !!t.pinned, active: !!t.active, audible: !!t.audible, groupId: t.groupId ?? -1, incognito: !!t.incognito,
      favIconUrl: t.favIconUrl || '', discarded: !!t.discarded, lastAccessed: t.lastAccessed,
      openedAt: m.openedAt, parentTabId: m.parentTabId ?? null, startTransition: m.startTransition,
      activations: m.activations || 0, lastActivated: m.lastActivated,
    };
  });
}

export async function groupTitleMap(ctx) {
  const groups = await ctx.chrome.tabGroups.query({});
  return new Map(groups.map((g) => [g.id, g.title || '']));
}

export async function bumpStat(ctx, key, n = 1) {
  const { stats = {} } = await ctx.chrome.storage.local.get('stats');
  stats[key] = (stats[key] || 0) + n;
  await ctx.chrome.storage.local.set({ stats });
}
