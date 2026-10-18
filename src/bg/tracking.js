// Event tracking: usage, dwell, co-usage (site- and tab-level), lineage, start transitions.
import { normalizeUrl, siteKey, isWebUrl } from '../lib/url.js';
import { bump, dwellCredit, pairKey } from '../lib/scoring.js';
import { ROOT_TRANSITIONS } from '../lib/lineage.js';

export const CO_USE_WINDOW_MS = 10 * 60e3;
export const TAB_PAIR_WINDOW_MS = 5 * 60e3;

export function tracking(ctx) {
  const { chrome } = ctx;

  /** Incognito tabs are tracked in memory for this session only; their URLs never reach storage.local. */
  const persistable = (tab) => !tab?.incognito;

  function rememberLineage(childId) {
    const m = ctx.state.meta[childId];
    if (!m || m.parentTabId == null || !m.url || m.incognito) return;
    const p = ctx.state.meta[m.parentTabId];
    if (!p?.url || p.incognito || !isWebUrl(m.url) || !isWebUrl(p.url)) return;
    const ck = normalizeUrl(m.url), pk = normalizeUrl(p.url);
    if (ck !== pk) ctx.state.urlLineage[ck] = { p: pk, t: ctx.now() };
  }

  function creditDwell(now) {
    const prev = ctx.state.lastActive;
    if (!prev?.url || prev.incognito) return;
    const credit = dwellCredit(now - prev.at);
    if (credit > 0) {
      const uk = normalizeUrl(prev.url), sk = siteKey(prev.url);
      ctx.state.usage.urls[uk] = bump(ctx.state.usage.urls[uk], credit, now, ctx.hl(), false);
      ctx.state.usage.sites[sk] = bump(ctx.state.usage.sites[sk], credit * 0.5, now, ctx.hl(), false);
    }
  }

  function recordActivation(tab) {
    const now = ctx.now();
    const url = tab.url || tab.pendingUrl || '';
    if (ctx.state.lastActive?.tabId === tab.id) return;
    creditDwell(now);
    const prev = ctx.state.lastActive;
    if (url && persistable(tab) && !url.startsWith(ctx.ownPrefix())) {
      const uk = normalizeUrl(url), sk = siteKey(url);
      const hl = ctx.hl();
      ctx.state.usage.urls[uk] = bump(ctx.state.usage.urls[uk], 1, now, hl);
      ctx.state.usage.sites[sk] = bump(ctx.state.usage.sites[sk], 1, now, hl);
      if (prev?.url && !prev.incognito && !prev.url.startsWith(ctx.ownPrefix())) {
        const dt = now - prev.at;
        // Site-level co-usage feeds learning; tab-level co-usage feeds goal grouping.
        if (dt < CO_USE_WINDOW_MS) {
          const ps = siteKey(prev.url);
          if (ps !== sk) { const k = pairKey(ps, sk); ctx.state.pairs[k] = bump(ctx.state.pairs[k], 1, now, hl); }
        }
        if (dt < TAB_PAIR_WINDOW_MS) {
          const pu = normalizeUrl(prev.url);
          if (pu !== uk) { const k = pairKey(pu, uk); ctx.state.tabPairs[k] = bump(ctx.state.tabPairs[k], 1, now, hl); }
        }
      }
    }
    const m = ctx.meta(tab.id);
    m.activations = (m.activations || 0) + 1;
    m.lastActivated = now;
    if (tab.incognito) m.incognito = true;
    if (url) m.url = url;
    ctx.state.lastActive = { tabId: tab.id, url, at: now, incognito: !!tab.incognito };
    ctx.saveSoon();
  }

  return {
    recordActivation,

    async onCreated(tab) {
      await ctx.ready();
      const m = ctx.meta(tab.id);
      m.openedAt = ctx.now();
      m.seeded = false;
      m.url = tab.pendingUrl || tab.url || m.url;
      if (tab.incognito) m.incognito = true;
      if (tab.openerTabId != null) { m.parentTabId = tab.openerTabId; m.via = 'opener'; }
      ctx.saveSoon();
    },

    async onCreatedNavigationTarget({ sourceTabId, tabId, url }) {
      await ctx.ready();
      const m = ctx.meta(tabId);
      if (m.parentTabId == null && sourceTabId !== tabId) { m.parentTabId = sourceTabId; m.via = 'opener'; }
      if (url) m.url = url;
      rememberLineage(tabId);
      ctx.saveSoon();
    },

    async onCommitted({ tabId, frameId, transitionType, transitionQualifiers = [] }) {
      if (frameId !== 0) return;
      await ctx.ready();
      const m = ctx.meta(tabId);
      if (!m.startTransition) m.startTransition = transitionType;
      // Typing a URL or opening a bookmark in an existing tab repurposes it: it's nobody's child now.
      if (ROOT_TRANSITIONS.has(transitionType) && !transitionQualifiers.includes('forward_back')) {
        m.parentTabId = null;
        m.via = transitionType;
        m.startTransition = transitionType;
      }
      ctx.saveSoon();
    },

    async onUpdated(tabId, change) {
      if (change.status === 'complete') ctx.onPageLoaded?.(tabId);
      if (!change.url) return;
      await ctx.ready();
      ctx.meta(tabId).url = change.url;
      rememberLineage(tabId);
      ctx.jevCache.delete(tabId);
      ctx.saveSoon();
    },

    async onActivated({ tabId }) {
      await ctx.ready();
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { return; } // closed before we looked
      recordActivation(tab);
    },

    async onFocusChanged(windowId) {
      await ctx.ready();
      if (windowId === chrome.windows.WINDOW_ID_NONE) {
        creditDwell(ctx.now());
        ctx.state.lastActive = null;
        ctx.saveSoon();
        return;
      }
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab) recordActivation(tab);
    },

    async onRemoved(tabId) {
      await ctx.ready();
      const gone = ctx.state.meta[tabId];
      for (const m of Object.values(ctx.state.meta)) if (m.parentTabId === tabId) m.parentTabId = gone?.parentTabId ?? null;
      delete ctx.state.meta[tabId];
      delete ctx.state.linkEdges[tabId];
      ctx.jevCache.delete(tabId);
      if (ctx.state.lastActive?.tabId === tabId) ctx.state.lastActive = null;
      ctx.saveSoon();
    },

    async onReplaced(added, removed) {
      await ctx.ready();
      const meta = ctx.state.meta;
      if (meta[removed]) { meta[added] = meta[removed]; delete meta[removed]; }
      for (const m of Object.values(meta)) if (m.parentTabId === removed) m.parentTabId = added;
      if (ctx.state.lastActive?.tabId === removed) ctx.state.lastActive.tabId = added;
      ctx.saveSoon();
    },
  };
}
