// Ask: move and merge tabs by saying so. Pure helpers (no Chrome): parse an instruction, resolve group
// names, pick the tabs it means, and decide what to ask when that takes a guess.
//
// Jev answers typed questions and never writes text, so the parsing of the instruction is done here in
// code; Jev only judges which tabs fit the description (see buildMatchRequests in jev.js).
import { hostOf, registrableDomain } from './url.js';
import { tabTerms } from './goals.js';

/** Jev noul thresholds: at or above SURE a tab moves; between MAYBE and SURE we ask. */
export const SURE = 0.7;
export const MAYBE = 0.35;
export const MAX_QUESTIONS = 3;

const clean = (s) => String(s || '').trim().replace(/^["'“‘]+|["'”’.!?]+$/g, '').trim();
const groupName = (s) => clean(s).replace(/^(?:the|my|a|an|a new|new)\s+/i, '').replace(/\s+groups?$/i, '').trim();
const FILLER = /^(?:all\s+(?:of\s+)?(?:the\s+|my\s+)?|the\s+|my\s+|these\s+|those\s+|any\s+|every\s+)/i;
const TAB_WORDS = /\s+(?:tabs?|pages?|ones|windows?|sites?)$/i;
const WHAT_STOP = new Set('a an and or the of for to in on my all any these those every tab tabs page pages ones open about with that are is related stuff things'.split(' '));

/** "the LinkedIn tabs" → "linkedin" */
export function cleanWhat(s) {
  let w = clean(s);
  for (let i = 0; i < 3; i++) w = w.replace(FILLER, '');
  return w.replace(TAB_WORDS, '').trim();
}

/**
 * Parse one instruction. Returns one of:
 *   {kind:'merge', from:[names], into:name|null}
 *   {kind:'move', what, from:name|null, into:name|null}   into null = take out of the group
 *   {kind:'rename', group, to}
 *   {kind:'ungroup', group}
 *   {kind:'unknown'}
 */
export function parseInstruction(text) {
  const t = clean(text).replace(/\s+/g, ' ').replace(/^(?:please|can you|could you|pls)\s+/i, '');
  let m;
  if ((m = t.match(/^(?:merge|combine|join)\s+(.+?)\s+(?:into|in|to|onto)\s+(.+)$/i))) {
    return { kind: 'merge', from: splitList(m[1]), into: groupName(m[2]) };
  }
  if ((m = t.match(/^(?:merge|combine|join)\s+(.+)$/i))) {
    const parts = splitList(m[1].replace(/\s+(?:together|groups?)$/i, ''));
    if (parts.length >= 2) return { kind: 'merge', from: parts, into: null };
  }
  if ((m = t.match(/^rename\s+(.+?)\s+(?:to|as|into)\s+(.+)$/i))) return { kind: 'rename', group: groupName(m[1]), to: clean(m[2]) };
  if ((m = t.match(/^(?:ungroup|dissolve|break up|disband)\s+(.+)$/i))) return { kind: 'ungroup', group: groupName(m[1]) };
  if ((m = t.match(/^(?:move|put|send|add|drop|place|stick|group|bring)\s+(.+?)\s+(?:into|in|to|under|onto|inside|as)\s+(?:a\s+new\s+group\s+(?:called|named)\s+)?(.+)$/i))) {
    const { what, from } = splitFrom(m[1]);
    return { kind: 'move', what, from, into: groupName(m[2]) };
  }
  if ((m = t.match(/^(?:take|pull|remove|get|move)\s+(.+?)\s+(?:out of|from)\s+(.+)$/i))) {
    return { kind: 'move', what: m[1], from: groupName(m[2]), into: null };
  }
  return { kind: 'unknown' };
}

function splitList(s) {
  return s.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s+with\s+|\s*&\s*/i).map(groupName).filter(Boolean);
}
function splitFrom(s) {
  const m = s.match(/^(.+?)\s+(?:out of|from)\s+(.+)$/i);
  return m ? { what: m[1], from: groupName(m[2]) } : { what: s, from: null };
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
/** "Growth 2" → "growth" (Chrome and Tab Land number repeated names). */
export const baseName = (s) => norm(s).replace(/\s*(?:\(\d+\)|\d+)$/, '').trim();

/**
 * Find the group a name means. groups: [{id, title, count, windowId}].
 * → {match: group|null, candidates: [groups]} — several candidates means ask which.
 */
export function resolveGroup(name, groups) {
  const n = norm(name);
  if (!n) return { match: null, candidates: [] };
  const exact = groups.filter((g) => norm(g.title) === n);
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  if (exact.length > 1) return { match: null, candidates: exact };
  const loose = groups.filter((g) => {
    const t = norm(g.title);
    return t && (t.startsWith(n) || n.startsWith(t) || baseName(t) === baseName(n));
  });
  if (loose.length === 1) return { match: loose[0], candidates: loose };
  if (loose.length > 1) return { match: null, candidates: loose };
  return { match: null, candidates: [] };
}

/** Site names a description can mean exactly: "linkedin", "posthog", "github.com". */
function siteLabels(url) {
  const host = hostOf(url);
  const reg = registrableDomain(host);
  return new Set([host, reg, reg.split('.')[0], ...host.split('.')].filter((x) => x && x.length > 2));
}

/**
 * Pick the tabs a description means when no guessing is needed:
 *   - empty / "all" / "everything" → the whole pool
 *   - a group's name → that group's tabs
 *   - a site name ("LinkedIn tabs") → the pool's tabs on that site
 * → {tabIds, how} or null when it takes judgment.
 */
export function exactSelection(what, pool, groups = []) {
  const w = cleanWhat(what);
  const lw = norm(w);
  if (!lw || /^(?:everything|all|it|them|everything else)$/.test(lw)) return { tabIds: pool.map((t) => t.id), how: 'all' };
  const g = resolveGroup(w, groups);
  if (g.match) {
    const ids = pool.filter((t) => t.groupId === g.match.id).map((t) => t.id);
    if (ids.length) return { tabIds: ids, how: 'group', group: g.match };
  }
  const words = lw.split(/[\s,]+/).filter((x) => x && !WHAT_STOP.has(x));
  if (words.length >= 1 && words.length <= 2) {
    const hit = pool.filter((t) => { const labels = siteLabels(t.url); return words.every((x) => labels.has(x) || labels.has(x.replace(/\s+/g, ''))); });
    if (hit.length) return { tabIds: hit.map((t) => t.id), how: 'site' };
  }
  return null;
}

/** Without Jev: share of the description's words found in each tab's title and path. → Map<id, p> */
export function localMatch(what, pool) {
  const words = norm(cleanWhat(what)).split(/[^a-z0-9]+/).filter((x) => x.length > 1 && !WHAT_STOP.has(x));
  const out = new Map();
  if (!words.length) return out;
  for (const t of pool) {
    const hay = `${norm(t.title)} ${hostOf(t.url)} ${norm(decodeSafe(t.url))}`;
    const hits = words.filter((x) => hay.includes(x) || (x.length > 4 && hay.includes(x.replace(/s$/, '')))).length;
    out.set(t.id, hits / words.length);
  }
  return out;
}
function decodeSafe(u) { try { return decodeURIComponent(u); } catch { return u; } }

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
