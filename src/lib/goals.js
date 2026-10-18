// Goal grouping: cluster tabs by the job they serve, not the site they're on.
//
// Evidence between two tabs (being on the same site earns nothing by itself):
//   lineage   one was opened from the other (strong for opener/history/link, weak for same-site guesses)
//   together  you switch between these two specific tabs
//   burst     they were opened within two minutes of each other in one window
//   words     their titles (and paths, and optional page text) share distinctive terms
//   entity    they share an identifier: ENG-482, an order number, a ticket key
// Clusters form by average linkage, so a single shared word or one long chain can't glue unrelated tabs.
import { hostOf, registrableDomain, normalizeUrl, parseUrl, siteKey } from './url.js';
import { pairWeight } from './scoring.js';

const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in into is it its just me my no not of on or our out over so than that the their them then there these they this to too up us was we were what when where which who why will with you your yours
about after again all also any back because before being below between both down during each few further here more most new now off once only other own same she should some such through under until very via vs while would
re fw fwd am pm today yesterday tomorrow untitled page home dashboard inbox search results result view edit editing settings overview loading sign signin login logout log welcome
doc docs document documents sheet sheets slides drive google gmail mail email calendar github gitlab linear notion slack figma jira confluence atlassian microsoft outlook office teams zoom meet
pull pulls request requests issue issues commit commits branch branches files file changed compare tree blob main master readme
tab tabs app apps www com org net io co http https html htm php aspx index default share shared open opened
one two three first last next previous prev more less get set add new create created update updated delete`.split(/\s+/));

const ENTITY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;           // ENG-482, OPS-12
const LONG_ID = /\b(?!(?:19|20)\d{2}\b)\d{4,9}\b/g;           // order/claim ids, not years
const SEP = /[\s\-_/|·—–:,.;()[\]{}"'!?#@&+=*<>~`^$%\\]+/;

/** Words that only say where a tab is: host labels and the org/repo/workspace part of the site key. */
function siteWords(url) {
  const host = hostOf(url);
  const words = new Set(host.split('.'));
  const reg = registrableDomain(host).split('.')[0];
  if (reg) words.add(reg);
  for (const seg of siteKey(url).split('/').slice(1)) for (const w of seg.toLowerCase().split(/[-_.]+/)) if (w) words.add(w);
  return words;
}

/** "owner/repo" in a title that matches the start of the URL path is location, not the job. */
function pathOwnerWords(title, url) {
  const out = new Set();
  const u = parseUrl(url);
  if (!u) return out;
  const path = u.pathname.toLowerCase();
  for (const m of String(title).matchAll(/([\w.-]+)\/([\w.-]+)/g)) {
    const [a, b] = [m[1].toLowerCase(), m[2].toLowerCase()];
    if (path.startsWith(`/${a}/${b}`)) { out.add(a); out.add(b); }
  }
  return out;
}

/** Terms for one tab: {terms: Map<term, weight>, entities: Set, display: Map<term, original casing>} */
export function tabTerms(tab, { pageText = '' } = {}) {
  const terms = new Map();
  const display = new Map();
  const entities = new Set();
  const site = siteWords(tab.url);
  for (const w of pathOwnerWords(tab.title, tab.url)) site.add(w);
  const add = (raw, w) => {
    const lower = raw.toLowerCase();
    if (lower.length < 3 || STOP.has(lower) || site.has(lower) || /^\d+$/.test(lower)) return;
    terms.set(lower, (terms.get(lower) || 0) + w);
    if (!display.has(lower)) display.set(lower, raw);
  };
  const title = String(tab.title || '');
  for (const m of title.matchAll(ENTITY)) entities.add(m[0]);
  for (const m of title.matchAll(LONG_ID)) entities.add(m[0]);
  // Identifiers are entities, not words: "ENG-482" must not also count as "eng".
  for (const w of title.replace(ENTITY, ' ').replace(LONG_ID, ' ').split(SEP)) if (w) add(w, 1);
  const u = parseUrl(tab.url);
  if (u) {
    let path;
    try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
    const upper = path.toUpperCase();
    for (const m of upper.matchAll(ENTITY)) entities.add(m[0]);
    for (const seg of path.replace(new RegExp(ENTITY.source, 'gi'), ' ').split(SEP)) if (seg && /[a-z]/i.test(seg) && seg.length <= 30) add(seg, 0.5);
  }
  if (pageText) for (const w of String(pageText).slice(0, 2000).split(SEP)) if (w) add(w, 0.4);
  return { terms, entities, display };
}

/** Inverse document frequency over the open tabs, so a word on every tab ("Acme") counts for little. */
export function idfOf(docs) {
  const df = new Map();
  for (const d of docs) for (const k of d.terms.keys()) df.set(k, (df.get(k) || 0) + 1);
  const n = docs.length;
  return (k) => Math.log(1 + n / (df.get(k) || n));
}

function cosine(a, b, idf) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { const w = v * idf(k); na += w * w; const o = b.get(k); if (o) dot += w * o * idf(k); }
  for (const [k, v] of b) { const w = v * idf(k); nb += w * w; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const WEIGHTS = { lineageStrong: 0.6, lineageWeak: 0.15, together: 0.7, burst: 0.15, words: 1.0, entity: 0.5, cap: 1.5 };

/**
 * Pairwise goal evidence.
 * @returns {{w:(a,b)=>number, why:(a,b)=>object, docs:Map<number,any>, idf:Function}}
 */
export function goalGraph(tabs, { edges = new Map(), tabPairs = {}, now = Date.now(), halfLifeMs = 3 * 864e5, pageText = new Map(), weights = WEIGHTS } = {}) {
  const docs = new Map(tabs.map((t) => [t.id, tabTerms(t, { pageText: pageText.get(t.id) })]));
  const idf = idfOf([...docs.values()]);
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const cache = new Map();
  const byId = new Map(tabs.map((t) => [t.id, t]));

  const why = (a, b) => {
    const k = key(a, b);
    if (cache.has(k)) return cache.get(k);
    const ta = byId.get(a), tb = byId.get(b);
    const r = { lineage: 0, together: 0, burst: 0, words: 0, entity: 0, total: 0 };
    const e = edges.get(a)?.parentId === b ? edges.get(a) : edges.get(b)?.parentId === a ? edges.get(b) : null;
    if (e) r.lineage = (['opener', 'history', 'link'].includes(e.via) ? weights.lineageStrong : weights.lineageWeak) * e.confidence;
    const tp = pairWeight(tabPairs, normalizeUrl(ta.url), normalizeUrl(tb.url), now, halfLifeMs);
    // The first hop between two tabs is just navigation; repeated back-and-forth is working on them together.
    if (tp > 1) r.together = weights.together * Math.min(1, (tp - 1) / 3);
    if (ta.windowId === tb.windowId && ta.openedAt && tb.openedAt && Math.abs(ta.openedAt - tb.openedAt) <= 120e3) r.burst = weights.burst;
    const da = docs.get(a), db = docs.get(b);
    r.words = weights.words * cosine(da.terms, db.terms, idf);
    for (const x of da.entities) if (db.entities.has(x)) { r.entity = weights.entity; break; }
    r.total = Math.min(weights.cap, r.lineage + r.together + r.burst + r.words + r.entity);
    cache.set(k, r);
    return r;
  };
  return { w: (a, b) => why(a, b).total, why, docs, idf };
}

/**
 * Average-linkage agglomerative clustering. Merges the closest pair of clusters while their mean
 * pairwise evidence is at least `threshold`; never builds a cluster bigger than `maxSize`.
 */
export function clusterGoals(ids, w, { threshold = 0.3, maxSize = 15 } = {}) {
  let clusters = ids.map((id) => [id]);
  const sim = (A, B) => { let s = 0; for (const a of A) for (const b of B) s += w(a, b); return s / (A.length * B.length); };
  for (;;) {
    let best = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[i].length + clusters[j].length > maxSize) continue;
        const s = sim(clusters[i], clusters[j]);
        if (s >= threshold && (!best || s > best.s)) best = { i, j, s };
      }
    }
    if (!best) break;
    const merged = [...clusters[best.i], ...clusters[best.j]];
    clusters = clusters.filter((_, k) => k !== best.i && k !== best.j);
    clusters.push(merged);
  }
  return clusters.filter((c) => c.length >= 2).sort((a, b) => b.length - a.length);
}

/** Cohesion of a cluster: mean pairwise evidence. */
export function cohesion(ids, w) {
  if (ids.length < 2) return 0;
  let s = 0, n = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { s += w(ids[i], ids[j]); n++; }
  return s / n;
}

const titleCase = (s) => (/^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Name a goal from what its tabs share: a shared identifier first (ENG-482), then the most distinctive
 * shared words, in the order they read in titles. Returns null when tabs share nothing meaningful.
 */
export function nameGoal(ids, docs, idf, { maxLen = 24 } = {}) {
  const need = ids.length <= 3 ? 2 : Math.ceil(ids.length / 2);
  const ent = new Map();
  for (const id of ids) for (const e of docs.get(id).entities) ent.set(e, (ent.get(e) || 0) + 1);
  const entity = [...ent].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0]?.[0];

  const count = new Map();
  for (const id of ids) for (const k of docs.get(id).terms.keys()) count.set(k, (count.get(k) || 0) + 1);
  const shared = [...count].filter(([, c]) => c >= need).map(([k, c]) => ({ k, score: c * idf(k) }));
  shared.sort((a, b) => b.score - a.score);
  const top = shared.slice(0, 2);
  if (!entity && !top.length) return null;
  // Keep the words in reading order of the first title that has them.
  const order = (k) => { for (const id of ids) { const i = [...docs.get(id).terms.keys()].indexOf(k); if (i >= 0) return i; } return 99; };
  top.sort((a, b) => order(a.k) - order(b.k));
  const display = (k) => { for (const id of ids) { const d = docs.get(id).display.get(k); if (d) return d; } return k; };
  const words = top.map((t) => titleCase(display(t.k)));
  let name = [entity, ...words].filter(Boolean).join(' ');
  if (name.length > maxLen) name = name.slice(0, maxLen).replace(/\s+\S*$/, '') || name.slice(0, maxLen);
  return name;
}

/**
 * Keep a goal's existing group name if most of its tabs are already in one managed group,
 * so names stay stable from run to run.
 */
export function stableName(ids, tabsById, titleById, managed) {
  const counts = new Map();
  for (const id of ids) { const g = tabsById.get(id)?.groupId; if (g != null && g >= 0) counts.set(g, (counts.get(g) || 0) + 1); }
  const [gid, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  const title = gid != null ? titleById.get(gid) : null;
  return title && n * 2 >= ids.length && managed.has(title.toLowerCase()) ? title : null;
}
