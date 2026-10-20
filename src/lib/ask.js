// Ask: move and merge tabs by saying so. Pure helpers (no Chrome).
//
// Jev reads the request. Code lists the choices (your groups, a new group, the words you typed that
// could be a name) and Jev picks among them in one call of typed questions (see buildRouteRequest in
// jev.js). A second call judges which tabs a move means. Jev never writes text: a new group name is
// always words copied from what you typed.
import { tabTerms } from './goals.js';

/** Jev noul thresholds: at or above SURE a tab moves; between MAYBE and SURE we ask. */
export const SURE = 0.7;
export const MAYBE = 0.35;
export const MAX_QUESTIONS = 3;
/** Routing: at or above ACT we go ahead; below ASK we ask which one you meant. */
export const ACT = 0.85;
export const ASK = 0.6;

/** What Ask can do. Keys are what code runs; descriptions are what Jev judges. */
export const ACTIONS = {
  move: 'Put some tabs into a group, an existing one or a new one',
  take_out: 'Take some tabs out of a group so they are no longer in any group',
  merge: 'Combine whole groups into one group',
  rename: 'Give an existing group a different name',
  ungroup: 'Dissolve a whole group; its tabs stay open',
  none: 'Something else, or not about organizing tabs into groups',
};
export const ACTION_LABELS = {
  move: 'Move tabs into a group', take_out: 'Take tabs out of a group', merge: 'Merge groups',
  rename: 'Rename a group', ungroup: 'Ungroup a group', none: 'Something else',
};

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
/** "Growth 2" → "growth" (Chrome and Tab Land number repeated names). */
export const baseName = (s) => norm(s).replace(/\s+(?:\(\d{1,2}\)|\d{1,2})$/, '').trim(); // "Q4" and "ENG-482" keep their numbers

const NAME_STOP = new Set('a an and or the of for to in into on out from my all any these those every tab tabs page pages group groups please can could you hyou u it them this that move put take merge rename call ungroup combine with as called named be should'.split(' '));

/**
 * Every run of up to five words in the request that could be a new group name, copied exactly.
 * Quoted text comes first. Runs that start or end on a filler word are skipped.
 */
export function nameSpans(text, { max = 60 } = {}) {
  const t = String(text || '').slice(0, 300);
  const out = [];
  const seen = new Set();
  const add = (x) => { const v = x.trim().replace(/^["'“‘]|["'”’.!?,]$/g, '').trim(); const k = v.toLowerCase(); if (v && v.length <= 60 && !seen.has(k)) { seen.add(k); out.push(v); } };
  for (const m of t.matchAll(/["“']([^"”']{1,60})["”']/g)) add(m[1]);
  const words = t.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.!?,;:]+$/, ''));
  for (let n = 5; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n);
      if (NAME_STOP.has(run[0].toLowerCase()) || NAME_STOP.has(run[n - 1].toLowerCase())) continue;
      add(run.join(' '));
    }
  }
  return out.slice(0, max);
}

/** A choice answer → {key, confidence, top:[[key, p]…]} (top = the likeliest few, for asking back). */
export function readChoice(a, { keep = 3, floor = 0.12 } = {}) {
  if (!a || !a.choice) return null;
  const probs = a.probabilities && typeof a.probabilities === 'object' ? Object.entries(a.probabilities) : [[a.choice, a.confidence ?? 1]];
  const top = probs.filter(([, p]) => typeof p === 'number' && p >= floor).sort((x, y) => y[1] - x[1]).slice(0, keep);
  return { key: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : (top[0]?.[1] ?? 0), top: top.length ? top : [[a.choice, 1]] };
}

/**
 * Turn borderline tabs into at most MAX_QUESTIONS yes/no questions, clustered by a shared title word so
 * one answer covers similar tabs ("Are the referral tabs part of Growth?").
 * → [{id, kind:'include', term|null, tabIds, samples}]
 */
export function includeQuestions(unsure, byId) {
  if (!unsure.length) return [];
  const terms = new Map();
  for (const id of unsure) {
    const t = byId.get(id);
    const { terms: ts, display } = tabTerms(t);
    for (const k of ts.keys()) { if (!terms.has(k)) terms.set(k, { ids: new Set(), label: display.get(k) || k }); terms.get(k).ids.add(id); }
  }
  const left = new Set(unsure);
  const qs = [];
  while (left.size && qs.length < MAX_QUESTIONS - 1) {
    let best = null;
    for (const [k, v] of terms) {
      const n = [...v.ids].filter((id) => left.has(id)).length;
      if (n >= 2 && (!best || n > best.n)) best = { k, n, label: v.label };
    }
    if (!best) break;
    const ids = [...terms.get(best.k).ids].filter((id) => left.has(id));
    ids.forEach((id) => left.delete(id));
    qs.push({ id: `q${qs.length + 1}`, kind: 'include', term: best.label, tabIds: ids });
  }
  if (left.size) qs.push({ id: `q${qs.length + 1}`, kind: 'include', term: null, tabIds: [...left] });
  return qs.map((q) => ({ ...q, samples: q.tabIds.slice(0, 3).map((id) => byId.get(id)?.title || '') }));
}

/**
 * Groups that look like they should be one: same name apart from a number, or tabs that share most
 * of their distinctive words. groups: [{id,title,count}]; tabsByGroup: Map<groupId, tabs>.
 * → [{into, from}] biggest first, at most `limit`.
 */
export function lookAlikes(groups, tabsByGroup, { limit = 3 } = {}) {
  const bag = new Map();
  for (const g of groups) {
    const s = new Set();
    for (const t of tabsByGroup.get(g.id) || []) for (const k of tabTerms(t).terms.keys()) s.add(k);
    bag.set(g.id, s);
  }
  const pairs = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const [a, b] = [groups[i], groups[j]];
      if (!a.title || !b.title) continue;
      const sameName = baseName(a.title) === baseName(b.title);
      const A = bag.get(a.id), B = bag.get(b.id);
      const inter = [...A].filter((x) => B.has(x)).length;
      const jac = A.size && B.size ? inter / (A.size + B.size - inter) : 0;
      if (!sameName && jac < 0.35) continue;
      const [into, from] = a.count >= b.count ? [a, b] : [b, a];
      pairs.push({ into, from, score: (sameName ? 1 : 0) + jac });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const used = new Set();
  const out = [];
  for (const p of pairs) {
    if (used.has(p.from.id)) continue;
    used.add(p.from.id);
    out.push({ into: p.into, from: p.from });
    if (out.length >= limit) break;
  }
  return out;
}
