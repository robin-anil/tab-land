// Palette ranking: how well a tab/closed tab/history entry matches a query, blended with usage.
import { hostOf, displayPath } from './url.js';

const norm = (s) => String(s || '').toLowerCase();

/** Word-start positions so "pr" matches "Pull Request" strongly. */
function initials(s) {
  return norm(s).split(/[\s\-_/.:|·—]+/).filter(Boolean).map((w) => w[0]).join('');
}

/**
 * Match score for one token against a haystack. 0 = no match.
 * Exact word-prefix > substring > initials > ordered subsequence.
 */
export function tokenScore(token, text) {
  const t = norm(text);
  if (!token || !t) return 0;
  const i = t.indexOf(token);
  if (i >= 0) {
    const atWord = i === 0 || /[\s\-_/.:|]/.test(t[i - 1]);
    return atWord ? 1 : 0.7;
  }
  if (token.length >= 2 && initials(text).includes(token)) return 0.6;
  // subsequence: every char in order, penalized by spread
  let pos = -1, first = -1;
  for (const ch of token) {
    pos = t.indexOf(ch, pos + 1);
    if (pos < 0) return 0;
    if (first < 0) first = pos;
  }
  const spread = (pos - first + 1) / token.length;
  return token.length >= 3 && spread <= 4 ? 0.3 / spread + 0.1 : 0;
}

/** Score an item ({title,url}) for a query. Every token must match title or url. */
export function matchScore(query, item) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const host = hostOf(item.url);
  const where = `${host}${displayPath(item.url, 200)}`;
  let total = 0;
  for (const tok of tokens) {
    const s = Math.max(tokenScore(tok, item.title) * 1.15, tokenScore(tok, where), tokenScore(tok, host) * 1.1);
    if (!s) return 0;
    total += s;
  }
  return total / tokens.length;
}

/**
 * Rank palette candidates.
 * @param {string} query
 * @param {Array<any>} items  {kind:'tab'|'closed'|'history', title, url, usage?, sameGroup?, sameWindow?, lastVisit?, ...passthrough}
 */
export function rankResults(query, items, { now = Date.now(), limits = { tab: 8, closed: 4, history: 5 } } = {}) {
  const q = norm(query).trim();
  const seen = new Set();
  const scored = [];
  for (const it of items) {
    const key = `${it.kind}|${it.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let s;
    if (!q) {
      if (it.kind !== 'tab') continue;
      s = 0.2;
    } else {
      s = matchScore(q, it);
      if (!s) continue;
    }
    // Usage pulls frequently used things up; context pulls the current task up.
    s += Math.min(0.6, Math.log1p(it.usage || 0) * 0.18);
    if (it.sameGroup) s += 0.15;
    if (it.sameWindow) s += 0.05;
    if (it.kind === 'closed') s -= 0.05;
    if (it.kind === 'history') {
      s -= 0.15;
      if (it.lastVisit) s += 0.1 * Math.pow(0.5, (now - it.lastVisit) / (7 * 864e5));
    }
    scored.push({ ...it, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const counts = { tab: 0, closed: 0, history: 0 };
  return scored.filter((r) => (counts[r.kind] = (counts[r.kind] || 0) + 1) <= (limits[r.kind] ?? 5));
}
