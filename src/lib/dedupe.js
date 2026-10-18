// Exact-duplicate detection and closable child-tab detection.
import { normalizeUrl, pageKey, detailWeight, hostOf, registrableDomain, isTransientPage, isWebUrl } from './url.js';
import { childrenCount } from './lineage.js';

const MIN = 60e3;

/**
 * Exact duplicates by normalized URL. Never closes pinned or active tabs.
 * Keeper: active > pinned > in a group > most used > most recently used > leftmost.
 */
export function findExactDuplicates(tabs, { crossWindow = true, scoreOf = (_t) => 0, isProtected = (_t) => false } = {}) {
  const buckets = new Map();
  for (const t of tabs) {
    if (!t.url) continue;
    const key = normalizeUrl(t.url) + (crossWindow ? '' : `|w${t.windowId}`);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const out = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) =>
      (+b.active - +a.active) || (+b.pinned - +a.pinned) ||
      (+(b.groupId >= 0) - +(a.groupId >= 0)) ||
      (scoreOf(b) - scoreOf(a)) ||
      ((b.lastAccessed || 0) - (a.lastAccessed || 0)) ||
      (a.windowId - b.windowId) || (a.index - b.index));
    const keep = ranked[0];
    const close = ranked.slice(1).filter((t) => !t.pinned && !t.active && !isProtected(t));
    if (close.length) out.push({ key, keep, close });
  }
  return out;
}

/**
 * Page versions under the master/detail model: tabs whose URLs differ only in details
 * (?view=, &sort=, #section, tracking) are versions of one page. The master is the version in use:
 * active > pinned > most recently used > the plain URL > most used. Every other version that has
 * been unused for `idleMinutes` is a detail that can go.
 * Returns [{tab, parent, reason, confidence, idleMin, signals:{via:'variant'}}].
 */
export function findPageVariants(tabs, { crossWindow = true, now = Date.now(), idleMinutes = 10, scoreOf = (_t) => 0, isProtected = (_t) => false, exclude = new Set() } = {}) {
  const families = new Map();
  for (const t of tabs) {
    if (!isWebUrl(t.url) || exclude.has(t.id)) continue;
    const key = pageKey(t.url) + (crossWindow ? '' : `|w${t.windowId}`);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(t);
  }
  const lastUse = (t) => Math.max(t.lastActivated || 0, t.lastAccessed || 0, t.openedAt || 0);
  const out = [];
  for (const list of families.values()) {
    if (list.length < 2) continue;
    // Only real variants: exact copies are handled as duplicates.
    if (new Set(list.map((t) => normalizeUrl(t.url))).size < 2) continue;
    const ranked = [...list].sort((a, b) =>
      (+b.active - +a.active) || (+b.pinned - +a.pinned) ||
      (lastUse(b) - lastUse(a)) || (detailWeight(a.url) - detailWeight(b.url)) ||
      (scoreOf(b) - scoreOf(a)) || (a.index - b.index));
    const master = ranked[0];
    for (const t of ranked.slice(1)) {
      if (t.pinned || t.active || t.audible || isProtected(t)) continue;
      const idleMin = (now - lastUse(t)) / MIN;
      if (idleMin < idleMinutes) continue;
      out.push({
        tab: t, parent: master, confidence: 0.97, idleMin,
        reason: 'Another version of a page you have open',
        signals: { via: 'variant', activations: t.activations || 0 },
      });
    }
  }
  return out;
}

/**
 * Children that can be closed because their master (parent) tab is still open.
 * Returns [{tab, parent, reason, confidence, idleMin, signals}] sorted by confidence.
 */
export function findClosableChildren(tabs, edges, {
  now = Date.now(), staleMinutes = 30, transientMinutes = 10,
  scoreOf = (_t) => 0, isProtected = (_t) => false, exclude = new Set(),
} = {}) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const kids = childrenCount(edges);
  const out = [];
  for (const t of tabs) {
    if (exclude.has(t.id) || t.pinned || t.active || t.audible || isProtected(t)) continue;
    const lastUse = Math.max(t.lastActivated || 0, t.lastAccessed || 0, t.openedAt || 0);
    const idleMin = lastUse ? (now - lastUse) / MIN : Infinity;
    const edge = edges.get(t.id);
    const parent = edge ? byId.get(edge.parentId) : null;

    if (isWebUrl(t.url) && isTransientPage(t.url) && idleMin >= transientMinutes && !kids.get(t.id)) {
      out.push({ tab: t, parent, reason: 'Sign-in / redirect page left behind', confidence: 0.9, idleMin, signals: { via: edge?.via || 'transient' } });
      continue;
    }
    if (!edge || !parent) continue;
    if (kids.get(t.id)) continue; // only leaves: closing a mid-chain tab would orphan its children
    if (idleMin < staleMinutes) continue;

    const cs = scoreOf(t), ps = scoreOf(parent);
    const activations = t.activations || 0;
    // The child has become the main thing the user works in: not a throwaway.
    if (activations > 2 && cs > ps * 1.5) continue;

    let confidence = edge.confidence;
    const crossSite = registrableDomain(hostOf(t.url)) !== registrableDomain(hostOf(parent.url));
    if (crossSite) confidence *= 0.7;
    if (activations > 3) confidence *= 0.8;
    if (activations === 0) confidence = Math.min(0.99, confidence + 0.03);

    const reason = activations === 0
      ? 'Opened from parent, never viewed'
      : `Opened from parent, idle ${formatIdle(idleMin)}`;
    out.push({ tab: t, parent, reason, confidence, idleMin, signals: { via: edge.via, crossSite, activations } });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

export function formatIdle(min) {
  if (!isFinite(min)) return 'a long time';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}
