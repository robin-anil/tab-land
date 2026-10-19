// TypeSafe AI "Jev" client (System One API).
// Jev doesn't write text: it answers typed questions about a `state`:
//   choice → { choice, confidence, probabilities }   noul → { noul: 0..1 }
// We use `choice` to assign tabs to use cases and `noul` to judge whether a child tab is safe to close.
import { displayPath, siteKey } from './url.js';
import { formatIdle } from './dedupe.js';
import { describeUseCase, USE_CASE_VOCAB } from './learn.js';

export class JevError extends Error {
  constructor(message, status, requestId) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

function base(settings) {
  return String(settings.jevBaseUrl || 'https://api.typesafe.ai').replace(/\/+$/, '');
}

async function jevFetch(settings, path, init = {}, { retries = 2, fetchImpl = undefined, retryDelay = 500, timeoutMs = undefined } = {}) {
  if (!settings.jevApiKey) throw new JevError('No Jev API key set', 401);
  const doFetch = fetchImpl || globalThis.fetch;
  const limit = timeoutMs ?? settings.jevTimeoutMs ?? 15000;
  let attempt = 0;
  for (;;) {
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), limit);
    try {
      res = await doFetch(base(settings) + path, {
        ...init,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${settings.jevApiKey}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (e) {
      const timedOut = ctrl.signal.aborted;
      if (attempt++ < retries) { await sleep(retryDelay * 2 ** attempt); continue; }
      throw new JevError(timedOut ? `Jev timed out after ${Math.round(limit / 1000)}s` : `Network error: ${e.message}`, 0);
    } finally {
      clearTimeout(timer);
    }
    const requestId = res.headers?.get?.('x-typesafe-request-id') || '';
    if (res.ok) {
      try { return await res.json(); }
      catch { throw new JevError('Jev returned a response that is not JSON', res.status, requestId); }
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt++ < retries) { await sleep(retryDelay * 2 ** attempt); continue; }
    let detail = '';
    try { const j = await res.json(); detail = j?.error?.message || j?.message || JSON.stringify(j).slice(0, 200); } catch { /* ignore */ }
    const hint = { 401: 'invalid or missing API key', 403: 'key not allowed', 422: 'request rejected', 429: 'rate limited', 529: 'Jev is overloaded' }[res.status] || '';
    throw new JevError(`Jev ${res.status}${hint ? ` (${hint})` : ''}${detail ? `: ${detail}` : ''}`, res.status, requestId);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function jevModels(settings, opts) {
  return jevFetch(settings, '/v1/models', { method: 'GET' }, opts);
}

export function jevEvaluate(settings, body, opts) {
  return jevFetch(settings, '/v1/systemone', { method: 'POST', body: JSON.stringify(body) }, opts);
}

/** Run requests with bounded concurrency; failures are collected, not thrown. */
export async function runAll(settings, requests, { concurrency = 4, fetchImpl = undefined, retryDelay = undefined } = {}) {
  const results = new Array(requests.length);
  const errors = [];
  let i = 0;
  const worker = async () => {
    while (i < requests.length) {
      const idx = i++;
      try { results[idx] = await jevEvaluate(settings, requests[idx].body, { fetchImpl, retryDelay }); }
      catch (e) {
        errors.push(e);
        results[idx] = null;
        if (e.status === 401 || e.status === 403) { i = requests.length; } // bad key: don't hammer the API
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
  return { results, errors };
}

// ---------- describing tabs (privacy-aware) ----------

export function describeTab(tab, settings) {
  const title = settings.sendTitles ? clip(tab.title || '(untitled)', 90) : '(title hidden)';
  const where = settings.sendPaths ? `${siteKey(tab.url).split('/')[0]}${displayPath(tab.url, 60)}` : siteKey(tab.url).split('/')[0];
  return `"${title}" — ${where}`;
}

function clip(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------- grouping: one `choice` question per tab ----------

/**
 * @param {Array} tabs  tabs allowed to be sent (already privacy-filtered)
 * @param {{useCases, existingGroups:string[], goals?:Array<{name:string, samples?:string[]}>, settings, related?:Map<number,{openedFrom?:number, usedWith?:number[], group?:string}>, chunk?:number}} o
 * @returns {Array<{body:any, idMap:any, options:any}>}
 */
// Jev's context limits (docs.typesafe.ai/models#context-length): 64k tokens per request (state plus
// all questions) and 32k per question; over that it answers 400 `max_tokens_exceeded`. Every question
// repeats the full option list, so with many goals we send fewer tabs per request. 80 KB of JSON is
// roughly 20-27k tokens, well inside the limit. A Choice question takes at most 255 options.
export const MAX_REQUEST_CHARS = 80000;
export const MAX_CHOICE_OPTIONS = 255;

export function buildGroupingRequests(tabs, { useCases, existingGroups = [], goals = [], settings, related = new Map(), chunk = 20, maxChars = MAX_REQUEST_CHARS }) {
  const shown = tabs.slice(0, 150);
  const num = new Map(shown.map((t, i) => [t.id, i + 1]));
  const lines = shown.map((t) => {
    const r = related.get(t.id) || {};
    const bits = [`[${num.get(t.id)}] ${describeTab(t, settings)}`];
    if (r.openedFrom != null && num.has(r.openedFrom)) bits.push(`opened from [${num.get(r.openedFrom)}]`);
    const w = (r.usedWith || []).filter((id) => num.has(id)).slice(0, 4).map((id) => `[${num.get(id)}]`);
    if (w.length) bits.push(`often used with ${w.join(', ')}`);
    if (r.group) bits.push(`currently in group "${r.group}"`);
    return bits.join('; ');
  });
  const state = `Open browser tabs. Each line: [n] "title" — site/path; plus how tabs relate (opened from, often switched between, current group).\n\n${lines.join('\n')}`;

  // Option keys are slugs; names map back.
  const options = {};
  const criteria = {};
  const seen = new Set();
  // Goals found this run come first: a stray tab joining an active goal beats a generic category.
  goals.forEach((g, i) => {
    if (!g?.name || seen.has(g.name.toLowerCase())) return;
    seen.add(g.name.toLowerCase());
    options[`g${i}`] = g.name;
    criteria[`g${i}`] = `${g.name}: a goal in progress, with tabs like ${(g.samples || []).slice(0, 3).map((t) => `"${clip(t, 50)}"`).join(', ')}`;
  });
  useCases.forEach((u, i) => {
    if (!u?.name || seen.has(u.name.toLowerCase())) return;
    seen.add(u.name.toLowerCase());
    options[`uc${i}`] = u.name;
    criteria[`uc${i}`] = `${u.name}: ${describeUseCase(u)}`;
  });
  existingGroups.forEach((g, i) => {
    if (!g || seen.has(g.toLowerCase())) return;
    seen.add(g.toLowerCase());
    options[`ex${i}`] = g;
    criteria[`ex${i}`] = `${g}: an existing tab group the user already made`;
  });
  // Leave room for `none`: goals come first, so it's the generic categories that get trimmed.
  for (const k of Object.keys(options).slice(MAX_CHOICE_OPTIONS - 1)) { delete options[k]; delete criteria[k]; }
  options.none = null;
  criteria.none = 'None of these: a one-off tab that does not belong with others';

  const qSize = JSON.stringify({ type: 'choice', instructions: 'x'.repeat(200), criteria }).length + 16;
  const fit = Math.max(1, Math.min(chunk, Math.floor((maxChars - state.length - 200) / qSize)));
  const requests = [];
  for (let s = 0; s < shown.length; s += fit) {
    const questions = {};
    const idMap = {};
    for (const t of shown.slice(s, s + fit)) {
      const q = `tab_${num.get(t.id)}`;
      idMap[q] = t.id;
      questions[q] = {
        type: 'choice',
        instructions: `Which use case or project is tab [${num.get(t.id)}] part of? Judge by the work it serves, using the tabs it was opened from and is used with, not just its website.`,
        criteria,
      };
    }
    requests.push({ body: { model: settings.jevModel || 'jev-latest', state, questions }, idMap, options });
  }
  return requests;
}

/** → Map<tabId, {name|null, confidence, probabilities}> */
export function parseGroupingResponses(requests, results) {
  const out = new Map();
  requests.forEach((req, i) => {
    const answers = results[i]?.answers;
    if (!answers) return;
    for (const [q, tabId] of Object.entries(req.idMap)) {
      const a = answers[q];
      if (!a || !a.choice || !(a.choice in req.options)) continue;
      out.set(tabId, { name: req.options[a.choice], confidence: num(a.confidence, a.probabilities?.[a.choice]) });
    }
  });
  return out;
}

// ---------- goals: verify a cluster, prune outliers, name it when titles share nothing ----------

/**
 * One request per candidate goal: `goal` (do these tabs serve one goal?), `member_i` per tab for
 * clusters of 3+, and a `name` choice from the vocabulary when the tabs share no usable words.
 * @param {Array<{tabs:any[], needName?:boolean}>} goals
 */
export function buildGoalRequests(goals, { settings, exclude = [] }) {
  const taken = new Set(exclude.map((n) => n.toLowerCase()));
  const nameOptions = {};
  const nameCriteria = {};
  USE_CASE_VOCAB.forEach(([name, desc], i) => {
    if (taken.has(name.toLowerCase())) return;
    nameOptions[`v${i}`] = name;
    nameCriteria[`v${i}`] = `${name}: ${desc}`;
  });
  return goals.map((g) => {
    const lines = g.tabs.map((t, i) => `[${i + 1}] ${describeTab(t, settings)}`);
    const questions = {
      goal: {
        type: 'noul',
        instructions: 'Do these browser tabs all serve one goal: the same task, project, problem, deal, person or deliverable?',
        criteria: { true: 'one piece of work spread across tools (e.g. an issue, its pull request, the runbook and the chat thread about it)', false: 'only the same website or tool, or unrelated tasks that happen to share words' },
      },
    };
    const idMap = {};
    if (g.tabs.length >= 3) {
      g.tabs.forEach((t, i) => {
        questions[`member_${i + 1}`] = { type: 'noul', instructions: `Is tab [${i + 1}] part of the goal the other tabs share?` };
        idMap[`member_${i + 1}`] = t.id;
      });
    }
    if (g.needName && Object.keys(nameCriteria).length) {
      questions.name = { type: 'choice', instructions: 'Which kind of work is this goal?', criteria: nameCriteria };
    }
    return { body: { model: settings.jevModel || 'jev-latest', state: `Browser tabs that may serve one goal.\n\n${lines.join('\n')}`, questions }, idMap, nameOptions };
  });
}

/** → [{p, members: Map<tabId, p>, name: string|null}] aligned with requests (null when the call failed). */
export function parseGoalResponses(requests, results) {
  return requests.map((req, i) => {
    const a = results[i]?.answers;
    if (!a) return null;
    const members = new Map();
    for (const [q, id] of Object.entries(req.idMap)) { const p = num(a[q]?.noul, a[q]?.probability); if (p != null) members.set(id, p); }
    const c = a.name?.choice;
    return { p: num(a.goal?.noul, a.goal?.probability), members, name: c && c in req.nameOptions ? req.nameOptions[c] : null };
  });
}

// ---------- learning: name a discovered cluster with one `choice` question ----------

/**
 * @param {Array<{sites:string[], titles:string[]}>} clusters
 * @param {{settings, exclude:string[]}} o  exclude: names already in use
 */
export function buildNamingRequests(clusters, { settings, exclude = [] }) {
  const taken = new Set(exclude.map((n) => n.toLowerCase()));
  const options = {};
  const criteria = {};
  USE_CASE_VOCAB.forEach(([name, desc], i) => {
    if (taken.has(name.toLowerCase())) return;
    options[`v${i}`] = name;
    criteria[`v${i}`] = `${name}: ${desc}`;
  });
  return clusters.map((c) => {
    const titles = settings.sendTitles ? (c.titles || []).slice(0, 8).map((t) => `"${clip(t, 80)}"`) : [];
    const state = `A set of websites this person uses together, often switching between them.\nSites: ${c.sites.join(', ')}${titles.length ? `\nRecent tab titles: ${titles.join('; ')}` : ''}`;
    return {
      body: { model: settings.jevModel || 'jev-latest', state, questions: { name: { type: 'choice', instructions: 'Which use case best describes the work these sites are used for together?', criteria } } },
      options,
    };
  });
}

export function parseNamingResponses(requests, results) {
  return requests.map((req, i) => {
    const a = results[i]?.answers?.name;
    if (!a?.choice || !(a.choice in req.options)) return null;
    return { name: req.options[a.choice], confidence: num(a.confidence, a.probabilities?.[a.choice]) ?? 0 };
  });
}

// ---------- closing: one `noul` question per (parent, child) candidate ----------

export function buildCloseReviewRequests(candidates, { settings, chunk = 15 }) {
  const requests = [];
  for (let s = 0; s < candidates.length; s += chunk) {
    const slice = candidates.slice(s, s + chunk);
    const blocks = slice.map((c, i) => {
      const p = c.parent;
      const via = { opener: 'opened by clicking in the parent', history: 'previously opened from the parent', link: 'parent links to it', path: 'URL sits under the parent', list: 'parent is a list/search page on the same site', adjacent: 'opened next to the parent on the same site', transient: 'sign-in/redirect page' }[c.signals?.via] || 'related';
      return [
        `Pair ${i + 1}:`,
        p ? `  Parent: ${describeTab(p, settings)} (viewed ${p.activations || 0}×)` : '  Parent: (none open)',
        `  Child: ${describeTab(c.tab, settings)} (${via}; viewed ${c.tab.activations || 0}×; idle ${formatIdle(c.idleMin)})`,
      ].join('\n');
    });
    const questions = {};
    const idMap = {};
    slice.forEach((c, i) => {
      const q = `pair_${i + 1}`;
      idMap[q] = c.tab.id;
      questions[q] = {
        type: 'noul',
        instructions: `Pair ${i + 1}: Is the child tab a throwaway page the user opened from the parent and is now done with, so closing it loses nothing while the parent stays open?`,
        criteria: {
          true: 'a result, item, link, preview or detail page spawned from the parent hub; idle and lightly used; easy to reopen from the parent',
          false: 'its own ongoing work: a document being edited, a long read in progress, a form, a call, or something the user keeps returning to',
        },
      };
    });
    requests.push({ body: { model: settings.jevModel || 'jev-latest', state: `Browser tabs that were opened from other tabs.\n\n${blocks.join('\n\n')}`, questions }, idMap });
  }
  return requests;
}

/**
 * Ask mode, step 1: read the request. One call, every question asked together (speculative fan-out):
 * which action, which group the tabs end up in, which group is acted on, which of the typed words
 * are a new name, and which groups are merged in. Code then uses only the answers the action needs.
 * groups: [{id, title, count, examples:[titles]}]; spans: candidate names copied from the request.
 */
export function buildRouteRequest(instruction, { groups, spans, actions, settings, maxGroups = 200 }) {
  const shown = groups.slice(0, Math.min(maxGroups, MAX_CHOICE_OPTIONS - 2));
  const gKey = new Map(shown.map((g, i) => [`g${i + 1}`, g.id]));
  const nEx = shown.length > 60 ? 1 : 3;
  const groupLine = (g) => `"${clip(g.title || 'Untitled', 50)}" (${g.count} tab${g.count === 1 ? '' : 's'})${settings.sendTitles && g.examples?.length ? `: ${g.examples.slice(0, nEx).map((t) => `"${clip(t, 40)}"`).join(', ')}` : ''}`;
  const groupCriteria = Object.fromEntries(shown.map((g, i) => [`g${i + 1}`, groupLine(g)]));
  const state = {
    request: clip(instruction, 300),
    note: 'The user typed this to organize their browser tabs. It may have typos or loose wording ("linked in" for LinkedIn).',
    groups: shown.map((g, i) => `g${i + 1}: ${groupLine(g)}`),
  };
  const questions = {
    action: { type: 'choice', instructions: 'What does the user want done?', criteria: { ...actions } },
    destination: {
      type: 'choice',
      instructions: 'If tabs are being moved into a group, or groups merged together, which group do they end up in?',
      criteria: { ...groupCriteria, new: 'A new group that does not exist yet', none: 'No group to end up in (taking tabs out, renaming, dissolving)' },
    },
    subject: {
      type: 'choice',
      instructions: 'Which existing group is the request acting on: the group tabs are taken out of, the group being renamed, or the group being dissolved?',
      criteria: { ...groupCriteria, none: 'No existing group is acted on this way' },
    },
  };
  const spanKey = new Map();
  if (spans.length) {
    const criteria = {};
    spans.forEach((x, i) => { criteria[`s${i + 1}`] = `"${clip(x, 60)}"`; spanKey.set(`s${i + 1}`, x); });
    criteria.none = 'No new name is given';
    questions.new_name = { type: 'choice', instructions: 'Which exact words in the request are the new name for a group (a group being created or renamed)?', criteria };
  }
  const mergeKey = new Map();
  if (shown.length <= 120) {
    shown.forEach((g, i) => {
      questions[`merge_${i + 1}`] = { type: 'noul', instructions: `Is group g${i + 1} ("${clip(g.title || 'Untitled', 50)}") one of the groups the user wants merged into another group?` };
      mergeKey.set(`merge_${i + 1}`, g.id);
    });
  }
  return { body: { model: settings.jevModel || 'jev-latest', state, questions }, gKey, spanKey, mergeKey };
}

/**
 * Ask mode: does each tab fit what the user described ("the dashboards and funnel reports")?
 * One noul per tab (docs: one yes/no judgment per question), all tabs in the state for context.
 * Batched under MAX_REQUEST_CHARS; parse with parseNoulResponses.
 */
export function buildMatchRequests(tabs, { description, target = '', settings, chunk = 40, maxChars = MAX_REQUEST_CHARS }) {
  const shown = tabs.slice(0, 200);
  const lines = shown.map((t, i) => `[${i + 1}] ${describeTab(t, settings)}`);
  const what = clip(description, 200);
  const state = `The user asked to organize their tabs${target ? ` (into the group "${clip(target, 60)}")` : ''}: "${what}". It may have typos or loose wording.\n\nOpen tabs, each line [n] "title" — site/path:\n${lines.join('\n')}`;
  const qSize = 420 + what.length;
  const fit = Math.max(1, Math.min(chunk, Math.floor((maxChars - state.length - 200) / qSize)));
  const requests = [];
  for (let s = 0; s < shown.length; s += fit) {
    const questions = {};
    const idMap = {};
    shown.slice(s, s + fit).forEach((t, k) => {
      const n = s + k + 1;
      idMap[`tab_${n}`] = t.id;
      questions[`tab_${n}`] = {
        type: 'noul',
        instructions: `Is tab [${n}] one of the tabs this request is about moving: "${what}"?`,
        criteria: { true: 'the page is what they described, or clearly part of it', false: 'the page is about something else, even if it is on a similar site' },
      };
    });
    requests.push({ body: { model: settings.jevModel || 'jev-latest', state, questions }, idMap });
  }
  return requests;
}

/** → Map<tabId, probability 0..1> */
export function parseNoulResponses(requests, results) {
  const out = new Map();
  requests.forEach((req, i) => {
    const answers = results[i]?.answers;
    if (!answers) return;
    for (const [q, tabId] of Object.entries(req.idMap)) {
      const a = answers[q];
      const p = num(a?.noul, a?.probability, a?.value);
      if (p != null) out.set(tabId, p);
    }
  });
  return out;
}

/** Heuristic confidence (lineage strength) blended with Jev's judgement. */
export function blendConfidence(heuristic, jevP) {
  if (jevP == null) return heuristic;
  return Math.max(0, Math.min(1, 0.4 * heuristic + 0.6 * jevP));
}

function num(...xs) {
  for (const x of xs) if (typeof x === 'number' && isFinite(x)) return x;
  return null;
}
