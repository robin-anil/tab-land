// Tab lineage: which tab was each tab opened from?
// Sources, strongest first:
//   opener   — Chrome told us (tabs.onCreated openerTabId / webNavigation.onCreatedNavigationTarget)
//   history  — we observed this URL being opened from that URL before (survives browser restarts)
//   link     — the candidate parent page contains a link to the child (optional, needs page access)
//   path     — child URL extends the parent's path on the same site (/repo → /repo/pull/12)
//   list     — parent is a hub page (search results, inbox, board) on the same site
//   adjacent — same site, opened just to the right of the parent
import { normalizeUrl, hostOf, registrableDomain, parseUrl, isListPage, isTransientPage, isWebUrl } from './url.js';

export const CONFIDENCE = { opener: 0.95, history: 0.85, link: 0.8, path: 0.6, list: 0.55, adjacent: 0.4 };

// Navigations that mean "the user started this tab themselves", so we don't infer a parent.
export const ROOT_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page']);

function isEarlier(a, b) {
  if (a.openedAt != null && b.openedAt != null && a.openedAt !== b.openedAt) return a.openedAt < b.openedAt;
  if (a.windowId === b.windowId) return a.index < b.index;
  return false;
}

function pathPrefix(parentUrl, childUrl) {
  const p = parseUrl(parentUrl), c = parseUrl(childUrl);
  if (!p || !c || p.hostname !== c.hostname) return false;
  const pp = p.pathname.replace(/\/+$/, '');
  const cp = c.pathname.replace(/\/+$/, '');
  return pp.length > 0 && cp !== pp && cp.startsWith(pp + '/');
}

/**
 * @param {Array} tabs  [{id,url,index,windowId,openedAt,parentTabId,startTransition}]
 * @param {{urlLineage?:Object, linkEdges?:Object}} ctx
 * @returns {Map<number,{parentId:number, via:string, confidence:number}>}
 */
export function buildLineage(tabs, { urlLineage = {}, linkEdges = {} } = {}) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const byKey = new Map();
  for (const t of tabs) {
    const k = normalizeUrl(t.url);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const edges = new Map();

  const createsCycle = (childId, parentId) => {
    let cur = parentId, hops = 0;
    while (cur != null && hops++ < 64) {
      if (cur === childId) return true;
      cur = edges.get(cur)?.parentId;
    }
    return false;
  };
  const add = (childId, parentId, via) => {
    if (parentId == null || parentId === childId || !byId.has(parentId)) return false;
    if (createsCycle(childId, parentId)) return false;
    edges.set(childId, { parentId, via, confidence: CONFIDENCE[via] });
    return true;
  };

  // Pass 1: explicit openers.
  for (const t of tabs) if (t.parentTabId != null) add(t.id, t.parentTabId, 'opener');

  // Pass 2: everything else.
  for (const t of tabs) {
    if (edges.has(t.id) || !isWebUrl(t.url)) continue;

    const remembered = urlLineage[normalizeUrl(t.url)];
    const parentKey = remembered && (typeof remembered === 'string' ? remembered : remembered.p);
    if (parentKey) {
      const cands = (byKey.get(parentKey) || []).filter((c) => c.id !== t.id);
      if (cands.length) {
        const sameWin = cands.find((c) => c.windowId === t.windowId) || cands[0];
        if (add(t.id, sameWin.id, 'history')) continue;
      }
    }

    if (linkEdges[t.id] != null && add(t.id, linkEdges[t.id], 'link')) continue;

    if (ROOT_TRANSITIONS.has(t.startTransition)) continue;

    const host = hostOf(t.url);
    const dom = registrableDomain(host);
    let best = null;
    for (const c of tabs) {
      if (c.id === t.id || !isWebUrl(c.url) || isTransientPage(c.url)) continue;
      if (registrableDomain(hostOf(c.url)) !== dom) continue;
      if (!isEarlier(c, t)) continue;
      if (normalizeUrl(c.url) === normalizeUrl(t.url)) continue; // exact dupes are handled elsewhere
      let via = null;
      if (pathPrefix(c.url, t.url)) via = 'path';
      else if (hostOf(c.url) === host && isListPage(c.url) && !isListPage(t.url)) via = 'list';
      else if (hostOf(c.url) === host && c.windowId === t.windowId && t.index - c.index > 0 && t.index - c.index <= 3) via = 'adjacent';
      if (!via) continue;
      const conf = CONFIDENCE[via];
      const dist = c.windowId === t.windowId ? Math.abs(t.index - c.index) : 999;
      if (!best || conf > best.conf || (conf === best.conf && dist < best.dist)) best = { id: c.id, via, conf, dist };
    }
    if (best) add(t.id, best.id, best.via);
  }
  return edges;
}

export function childrenCount(edges) {
  const m = new Map();
  for (const { parentId } of edges.values()) m.set(parentId, (m.get(parentId) || 0) + 1);
  return m;
}
