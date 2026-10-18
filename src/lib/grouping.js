// Turn per-tab use-case answers + behavioral signals into tab groups.
// Signals, in order of authority:
//   1. Jev choice (if confident)            2. learned site → group from past runs
//   3. lineage: inherit the parent's group   4. co-usage: join the group you're switched-with most
//   5. leftover same-site clusters (≥3 tabs) get a site-named group
import { siteKey, prettySite } from './url.js';
import { pairWeight } from './scoring.js';
import { hashColor } from './settings.js';

export function planGroups(tabs, {
  jev = new Map(), learned = {}, edges = new Map(), pairs = {}, now = Date.now(), halfLifeMs = 3 * 864e5,
  minChoiceConfidence = 0.45, useCases = [], existingColors = {}, minSize = 2, coUseThreshold = 1.5,
  siteClusterMin = 3, siteSignals = true,
} = {}) {
  const assign = new Map(); // tabId -> {name, source, confidence}
  const byId = new Map(tabs.map((t) => [t.id, t]));

  for (const t of tabs) {
    const j = jev.get(t.id);
    if (j && j.name && (j.confidence ?? 0) >= minChoiceConfidence) {
      assign.set(t.id, { name: j.name, source: 'jev', confidence: j.confidence });
    }
  }
  for (const t of tabs) {
    if (assign.has(t.id)) continue;
    const j = jev.get(t.id);
    if (j && j.name === null && (j.confidence ?? 0) >= 0.6) continue; // Jev is sure it's a one-off
    const l = siteSignals ? learned[siteKey(t.url)] : null;
    const name = typeof l === 'string' ? l : l?.name;
    if (name) assign.set(t.id, { name, source: 'learned', confidence: 0.6 });
  }

  // Lineage + co-usage propagation (two rounds so chains settle).
  for (let round = 0; round < 2; round++) {
    for (const t of tabs) {
      if (assign.has(t.id)) continue;
      const e = edges.get(t.id);
      if (e && e.confidence >= 0.5 && assign.has(e.parentId)) {
        assign.set(t.id, { name: assign.get(e.parentId).name, source: 'lineage', confidence: e.confidence * 0.8 });
        continue;
      }
      const votes = new Map();
      const sk = siteKey(t.url);
      if (siteSignals) for (const [id, a] of assign) {
        const w = pairWeight(pairs, sk, siteKey(byId.get(id).url), now, halfLifeMs);
        if (w > 0) votes.set(a.name, (votes.get(a.name) || 0) + w);
      }
      let best = null;
      for (const [name, w] of votes) if (!best || w > best.w) best = { name, w };
      if (best && best.w >= coUseThreshold) assign.set(t.id, { name: best.name, source: 'co-usage', confidence: 0.5 });
    }
  }

  // Leftover site clusters.
  const leftovers = new Map();
  for (const t of tabs) {
    if (assign.has(t.id)) continue;
    const j = jev.get(t.id);
    if (j && j.name === null && (j.confidence ?? 0) >= 0.6) continue;
    const sk = siteKey(t.url);
    if (!leftovers.has(sk)) leftovers.set(sk, []);
    leftovers.get(sk).push(t);
  }
  for (const [sk, list] of leftovers) {
    if (!siteSignals || list.length < siteClusterMin) continue;
    for (const t of list) assign.set(t.id, { name: prettySite(sk), source: 'site', confidence: 0.4 });
  }

  const ucColor = Object.fromEntries(useCases.map((u) => [u.name.toLowerCase(), u.color]));
  const groups = new Map();
  for (const [id, a] of assign) {
    const key = a.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: a.name, tabIds: [], sources: {} });
    const g = groups.get(key);
    g.tabIds.push(id);
    g.sources[a.source] = (g.sources[a.source] || 0) + 1;
  }
  const out = [];
  for (const [key, g] of groups) {
    const existing = key in existingColors;
    if (g.tabIds.length < minSize && !existing) continue;
    g.color = existingColors[key] || ucColor[key] || hashColor(g.name);
    g.existing = existing;
    out.push(g);
  }
  out.sort((a, b) => b.tabIds.length - a.tabIds.length);
  const grouped = new Set(out.flatMap((g) => g.tabIds));
  return { groups: out, ungrouped: tabs.filter((t) => !grouped.has(t.id)).map((t) => t.id), assign };
}

/** For each tab: the other open tabs it's most co-used with (for Jev context). */
export function relatedContext(tabs, { edges, pairs, now, halfLifeMs, groupTitles = new Map(), minWeight = 0.5 }) {
  const out = new Map();
  for (const t of tabs) {
    const sk = siteKey(t.url);
    const scored = [];
    for (const o of tabs) {
      if (o.id === t.id) continue;
      const w = pairWeight(pairs, sk, siteKey(o.url), now, halfLifeMs);
      if (w >= minWeight) scored.push([o.id, w]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    out.set(t.id, {
      openedFrom: edges.get(t.id)?.parentId,
      usedWith: scored.slice(0, 4).map(([id]) => id),
      group: groupTitles.get(t.groupId),
    });
  }
  return out;
}
