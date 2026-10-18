// Palette: search open tabs, recently closed tabs and history; open the chosen result.
import { normalizeUrl } from '../lib/url.js';
import { tabScore, DAY } from '../lib/scoring.js';
import { rankResults } from '../lib/search.js';
import { snapshot, bumpStat } from './context.js';

export async function activeTab(ctx) {
  const [t] = await ctx.chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  return t || null;
}

export async function search(ctx, q) {
  await ctx.ready();
  const { chrome } = ctx;
  const query = typeof q === 'string' ? q.slice(0, 200) : '';
  const now = ctx.now();
  const own = ctx.ownPrefix();
  const tabs = (await snapshot(ctx)).filter((t) => !t.url.startsWith(own));
  const active = await activeTab(ctx);
  const items = tabs.map((t) => ({
    kind: 'tab', id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl,
    usage: tabScore(t, ctx.state.usage, now, ctx.hl()),
    sameGroup: !!active && t.groupId >= 0 && t.groupId === active.groupId && t.id !== active.id,
    sameWindow: !!active && t.windowId === active.windowId,
  }));
  if (query.trim()) {
    const openKeys = new Set(tabs.map((t) => normalizeUrl(t.url)));
    try {
      for (const s of await chrome.sessions.getRecentlyClosed({ maxResults: 25 })) {
        for (const t of s.tab ? [s.tab] : (s.window?.tabs || [])) {
          if (!t.url || openKeys.has(normalizeUrl(t.url)) || t.url.startsWith(own)) continue;
          items.push({ kind: 'closed', sessionId: t.sessionId, title: t.title, url: t.url, favIconUrl: t.favIconUrl, usage: 0 });
        }
      }
    } catch (e) { ctx.log(e, 'search.sessions'); }
    try {
      for (const h of await chrome.history.search({ text: query, maxResults: 40, startTime: now - 90 * DAY })) {
        if (!h.url || openKeys.has(normalizeUrl(h.url))) continue;
        items.push({ kind: 'history', title: h.title || h.url, url: h.url, usage: Math.log1p(h.visitCount || 0), lastVisit: h.lastVisitTime });
      }
    } catch (e) { ctx.log(e, 'search.history'); }
  }
  return rankResults(query, items, { now }).map((r) => ({
    kind: r.kind, id: r.id, windowId: r.windowId, sessionId: r.sessionId, title: r.title, url: r.url,
    favIconUrl: r.favIconUrl || '', score: +r.score.toFixed(3),
  }));
}

export async function focusTab(ctx, tabId, windowId) {
  await ctx.chrome.tabs.update(tabId, { active: true });
  if (windowId != null) await ctx.chrome.windows.update(windowId, { focused: true });
}

/** Open a result. A tab closed since the search falls back to its URL; a stale session falls back too. */
export async function openResult(ctx, r) {
  const { chrome } = ctx;
  if (!r || !r.kind) return { ok: false, error: 'No result' };
  const byUrl = async () => {
    if (!r.url) return false;
    const open = (await chrome.tabs.query({})).find((t) => t.url && normalizeUrl(t.url) === normalizeUrl(r.url));
    if (open) await focusTab(ctx, open.id, open.windowId);
    else await chrome.tabs.create({ url: r.url, active: true });
    return true;
  };
  try {
    if (r.kind === 'tab') {
      try { await focusTab(ctx, r.id, r.windowId); } catch { await byUrl(); }
    } else if (r.kind === 'closed' && r.sessionId) {
      try { await chrome.sessions.restore(r.sessionId); } catch { await byUrl(); }
    } else {
      await byUrl();
    }
  } catch (e) {
    ctx.log(e, 'openResult');
    return { ok: false, error: e.message };
  }
  await bumpStat(ctx, 'jumps').catch(() => {});
  return { ok: true };
}
