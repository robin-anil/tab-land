// Frecency-style usage scoring with exponential decay, plus co-usage pair tracking.
import { normalizeUrl, siteKey } from './url.js';

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

export function decay(score, lastT, now, halfLifeMs) {
  if (!score || !lastT) return score || 0;
  const dt = Math.max(0, now - lastT);
  return score * Math.pow(0.5, dt / halfLifeMs);
}

/** Record an activation (+1) or partial credit (dwell) on a decayed entry. */
export function bump(entry, amount, now, halfLifeMs, countActivation = true) {
  const s = decay(entry?.s || 0, entry?.t, now, halfLifeMs) + amount;
  return { s, t: now, n: (entry?.n || 0) + (countActivation ? 1 : 0) };
}

/** Dwell credit: 20 focused minutes ≈ one extra activation, capped per stint. */
export function dwellCredit(ms) {
  const mins = Math.min(30, Math.max(0, ms / 60e3));
  return mins / 20;
}

export function tabScore(tab, usage, now, halfLifeMs) {
  const u = usage?.urls?.[normalizeUrl(tab.url)];
  const s = usage?.sites?.[siteKey(tab.url)];
  let score = decay(u?.s || 0, u?.t, now, halfLifeMs) + 0.35 * decay(s?.s || 0, s?.t, now, halfLifeMs);
  const last = Math.max(tab.lastActivated || 0, tab.lastAccessed || 0);
  if (last) score += 0.5 * Math.pow(0.5, Math.max(0, now - last) / (6 * HOUR));
  return score;
}

export function pairKey(a, b) {
  return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
}

export function pairWeight(pairs, a, b, now, halfLifeMs) {
  if (a === b) return 0;
  const p = pairs?.[pairKey(a, b)];
  return p ? decay(p.s, p.t, now, halfLifeMs) : 0;
}

/** Keep the N highest decayed entries of a {key: {s,t}} map. */
export function pruneMap(map, max, now, halfLifeMs) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const ranked = keys
    .map((k) => [k, decay(map[k].s, map[k].t, now, halfLifeMs)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  const out = {};
  for (const [k] of ranked) out[k] = map[k];
  return out;
}
