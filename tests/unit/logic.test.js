import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeUrl, siteKey, isListPage, isTransientPage, matchesDomain, registrableDomain } from '../../src/lib/url.js';
import { buildLineage } from '../../src/lib/lineage.js';
import { findExactDuplicates, findClosableChildren } from '../../src/lib/dedupe.js';
import { planWindowOrder } from '../../src/lib/reorder.js';
import { planGroups } from '../../src/lib/grouping.js';
import { bump, pairKey, DAY } from '../../src/lib/scoring.js';
import { buildGroupingRequests, parseGroupingResponses, buildCloseReviewRequests, parseNoulResponses, blendConfidence, jevEvaluate } from '../../src/lib/jev.js';
import { DEFAULTS } from '../../src/lib/settings.js';

const now = Date.UTC(2026, 9, 18, 16);
const MIN = 60e3;
let nextId = 1;
const tab = (url, o = {}) => ({ id: nextId++, url, title: o.title || url, index: o.index ?? 0, windowId: o.windowId ?? 1, pinned: false, active: false, audible: false, groupId: -1, openedAt: now - 60 * MIN, lastAccessed: now - 60 * MIN, activations: 1, ...o });

test('normalizeUrl strips tracking, trailing slash, www, anchors; keeps hash routes', () => {
  assert.equal(normalizeUrl('https://www.Example.com/a/?utm_source=x&b=2&a=1#top'), 'https://example.com/a?a=1&b=2');
  assert.equal(normalizeUrl('https://mail.google.com/mail/u/0/#inbox'), 'https://mail.google.com/mail/u/0#inbox');
  assert.notEqual(normalizeUrl('https://mail.google.com/mail/u/0/#inbox'), normalizeUrl('https://mail.google.com/mail/u/0/#sent'));
  assert.equal(normalizeUrl('https://app.example.com/#/settings'), 'https://app.example.com/#/settings');
  assert.equal(normalizeUrl('chrome://newtab/'), normalizeUrl('chrome://newtab'));
});

test('siteKey splits multi-app hosts', () => {
  assert.equal(siteKey('https://github.com/acme/api/pull/3'), 'github.com/acme/api');
  assert.equal(siteKey('https://docs.google.com/spreadsheets/d/abc'), 'docs.google.com/spreadsheets');
  assert.equal(siteKey('https://www.nytimes.com/2026/x'), 'nytimes.com');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
});

test('page type heuristics', () => {
  assert.ok(isListPage('https://www.google.com/search?q=x'));
  assert.ok(isListPage('https://github.com/acme/api/issues'));
  assert.ok(!isListPage('https://github.com/acme/api/issues/42'));
  assert.ok(isTransientPage('https://accounts.google.com/o/oauth2/auth?x'));
  assert.ok(isTransientPage('https://app.foo.com/auth/callback?code=1'));
  assert.ok(!isTransientPage('https://foo.com/author/jane'));
  assert.ok(matchesDomain('ehr.vendor.com', ['vendor.com']));
  assert.ok(!matchesDomain('notvendor.com', ['vendor.com']));
});

test('lineage: opener beats inference; path/list inference; typed tabs are roots; no cycles', () => {
  const search = tab('https://www.google.com/search?q=hipaa', { index: 0, openedAt: now - 50 * MIN });
  const res = tab('https://www.google.com/url-result-page', { index: 1, openedAt: now - 49 * MIN, parentTabId: search.id });
  const repo = tab('https://github.com/acme/api', { index: 2, openedAt: now - 40 * MIN });
  const pr = tab('https://github.com/acme/api/pull/12', { index: 5, openedAt: now - 39 * MIN });
  const issues = tab('https://linear.app/acme/team/ENG/active', { index: 6, openedAt: now - 30 * MIN });
  const issue = tab('https://linear.app/acme/issue/ENG-1', { index: 7, openedAt: now - 29 * MIN });
  const typed = tab('https://github.com/acme/api/pull/99', { index: 8, openedAt: now - 20 * MIN, startTransition: 'typed' });
  const a = tab('https://x.com/a', { index: 9, parentTabId: null });
  const b = tab('https://x.com/b', { index: 10 });
  const edges = buildLineage([search, res, repo, pr, issues, issue, typed, a, b], {
    urlLineage: { [normalizeUrl(a.url)]: normalizeUrl(b.url), [normalizeUrl(b.url)]: normalizeUrl(a.url) },
  });
  assert.equal(edges.get(res.id).via, 'opener');
  assert.equal(edges.get(pr.id).parentId, repo.id);
  assert.equal(edges.get(pr.id).via, 'path');
  assert.equal(edges.get(issue.id).via, 'list');
  assert.ok(!edges.has(typed.id));
  assert.ok(!(edges.has(a.id) && edges.has(b.id)), 'history cycle must be broken');
});

test('exact duplicates keep the active/pinned/most used copy and never close pinned or active', () => {
  const d1 = tab('https://notion.so/acme/Plan-1?utm_campaign=z', { index: 0 });
  const d2 = tab('https://www.notion.so/acme/Plan-1', { index: 1, active: true });
  const d3 = tab('https://notion.so/acme/Plan-1/', { index: 2, windowId: 2 });
  const p = tab('https://notion.so/acme/Plan-1', { index: 3, pinned: true, windowId: 3 });
  const res = findExactDuplicates([d1, d2, d3, p]);
  assert.equal(res.length, 1);
  assert.equal(res[0].keep.id, d2.id);
  assert.deepEqual(res[0].close.map((t) => t.id).sort(), [d1.id, d3.id].sort());
  const sameWin = findExactDuplicates([d1, d2, d3], { crossWindow: false });
  assert.deepEqual(sameWin[0].close.map((t) => t.id), [d1.id]);
});

test('closable children: stale leaf children of an open parent; respects heavy use and cross-site', () => {
  const parent = tab('https://github.com/acme/api/pulls', { index: 0, activations: 10, lastAccessed: now - 2 * MIN });
  const child = tab('https://github.com/acme/api/pull/7', { index: 1, parentTabId: parent.id, activations: 0, lastAccessed: now - 90 * MIN });
  const fresh = tab('https://github.com/acme/api/pull/8', { index: 2, parentTabId: parent.id, lastAccessed: now - 5 * MIN });
  const workhorse = tab('https://github.com/acme/api/pull/9', { index: 3, parentTabId: parent.id, activations: 20, lastAccessed: now - 45 * MIN });
  const cross = tab('https://docs.google.com/document/d/1', { index: 4, parentTabId: parent.id, activations: 1, lastAccessed: now - 120 * MIN });
  const login = tab('https://accounts.google.com/signin/v2', { index: 5, lastAccessed: now - 30 * MIN });
  const tabs = [parent, child, fresh, workhorse, cross, login];
  const edges = buildLineage(tabs);
  const scoreOf = (t) => t.activations;
  const res = findClosableChildren(tabs, edges, { now, scoreOf });
  const ids = res.map((r) => r.tab.id);
  assert.ok(ids.includes(child.id));
  assert.ok(!ids.includes(fresh.id), 'recently used child stays');
  assert.ok(!ids.includes(workhorse.id), 'child that became the main thing stays');
  assert.ok(ids.includes(login.id));
  const c = res.find((r) => r.tab.id === cross.id);
  assert.ok(c && c.confidence < 0.85, 'cross-site child is only a suggestion');
  assert.ok(res.find((r) => r.tab.id === child.id).confidence >= 0.95);
});

test('reorder: pinned stay first, groups move as blocks, highest usage first', () => {
  const t = [
    tab('https://a.com', { index: 0, pinned: true }),
    tab('https://b.com', { index: 1, s: 1 }),
    tab('https://c.com', { index: 2, s: 5, groupId: 9 }),
    tab('https://d.com', { index: 3, s: 0.5, groupId: 9 }),
    tab('https://e.com', { index: 4, s: 3 }),
  ];
  const plan = planWindowOrder(t, (x) => x.s || 0);
  assert.equal(plan.startIndex, 1);
  assert.deepEqual(plan.units.map((u) => u.type), ['group', 'tab', 'tab']);
  assert.deepEqual(plan.units[0].tabIds, [t[2].id, t[3].id]);
  assert.equal(plan.units[1].tabId, t[4].id);
  assert.ok(plan.changed);
});

test('grouping: Jev choices, lineage inheritance, co-usage, site leftovers', () => {
  const hl = 3 * DAY;
  const ats = tab('https://app.ashbyhq.com/candidates', { index: 0 });
  const li = tab('https://www.linkedin.com/in/someone', { index: 1, parentTabId: ats.id });
  const sheet = tab('https://docs.google.com/spreadsheets/d/x', { index: 2 });
  const y1 = tab('https://youtube.com/watch?v=1', { index: 3 });
  const y2 = tab('https://youtube.com/watch?v=2', { index: 4 });
  const y3 = tab('https://youtube.com/watch?v=3', { index: 5 });
  const tabs = [ats, li, sheet, y1, y2, y3];
  const edges = buildLineage(tabs);
  let pairs = {};
  pairs[pairKey('app.ashbyhq.com', 'docs.google.com/spreadsheets')] = bump(null, 3, now, hl);
  const jev = new Map([[ats.id, { name: 'Hiring', confidence: 0.9 }], [li.id, { name: 'Personal', confidence: 0.2 }]]);
  const { groups } = planGroups(tabs, { jev, edges, pairs, now, halfLifeMs: hl, useCases: DEFAULTS.useCases });
  const hiring = groups.find((g) => g.name === 'Hiring');
  assert.deepEqual(hiring.tabIds.sort(), [ats.id, li.id, sheet.id].sort());
  assert.equal(hiring.color, 'yellow');
  assert.ok(groups.find((g) => g.name === 'YouTube' && g.tabIds.length === 3));
});

test('Jev request building + parsing', () => {
  const settings = { ...DEFAULTS, jevApiKey: 'k' };
  const tabs = Array.from({ length: 25 }, (_, i) => tab(`https://site${i}.com/p?secret=1`, { index: i, title: `T${i}` }));
  const reqs = buildGroupingRequests(tabs, { useCases: DEFAULTS.useCases, existingGroups: ['Board Deck', 'hiring'], settings });
  assert.equal(reqs.length, 2);
  assert.equal(Object.keys(reqs[0].body.questions).length, 20);
  assert.ok(!reqs[0].body.state.includes('secret'), 'query strings never sent');
  const q = reqs[0].body.questions.tab_1;
  assert.equal(q.type, 'choice');
  assert.ok(Object.values(reqs[0].options).includes('Board Deck'));
  assert.equal(Object.values(reqs[0].options).filter((n) => n && n.toLowerCase() === 'hiring').length, 1);
  const fake = [{ answers: { tab_1: { type: 'choice', choice: 'uc6', confidence: 0.8 }, tab_2: { type: 'choice', choice: 'none', confidence: 0.9 } } }, null];
  const parsed = parseGroupingResponses(reqs, fake);
  assert.equal(parsed.get(tabs[0].id).name, 'Hiring');
  assert.equal(parsed.get(tabs[1].id).name, null);

  const hidden = buildGroupingRequests(tabs.slice(0, 1), { useCases: DEFAULTS.useCases, settings: { ...settings, sendTitles: false, sendPaths: false } });
  assert.ok(!hidden[0].body.state.includes('T0') && !hidden[0].body.state.includes('site0.com/p'));

  const cand = [{ tab: tabs[1], parent: tabs[0], idleMin: 90, signals: { via: 'opener' } }];
  const cr = buildCloseReviewRequests(cand, { settings });
  assert.equal(cr[0].body.questions.pair_1.type, 'noul');
  const np = parseNoulResponses(cr, [{ answers: { pair_1: { type: 'noul', noul: 0.9 } } }]);
  assert.equal(np.get(tabs[1].id), 0.9);
  assert.ok(Math.abs(blendConfidence(0.95, 0.9) - 0.92) < 1e-9);
});

test('Jev client sends bearer auth and retries 429', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer sk-test');
    if (calls === 1) return new Response('{}', { status: 429 });
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {} }), { status: 200 });
  };
  const r = await jevEvaluate({ ...DEFAULTS, jevApiKey: 'sk-test' }, { state: 'x', questions: {} }, { fetchImpl });
  assert.equal(r.model, 'jev-1.13.0');
  assert.equal(calls, 2);
});

import { matchScore, rankResults, tokenScore } from '../../src/lib/search.js';

test('palette: word-prefix beats substring beats subsequence; all tokens must match', () => {
  assert.ok(tokenScore('pull', 'Pull request #7') > tokenScore('ull', 'Pull request #7'));
  assert.ok(tokenScore('pr', 'Pull Request') >= 0.6, 'initials');
  assert.ok(tokenScore('plq', 'pull request queue') > 0, 'subsequence');
  assert.equal(matchScore('github zzz', { title: 'PR', url: 'https://github.com/a' }), 0);
  assert.ok(matchScore('github pull', { title: 'Pull request', url: 'https://github.com/a/pull/1' }) > 0.9);
});

test('palette: usage and context break ties; per-kind limits; history ranks below open tabs', () => {
  const items = [
    { kind: 'tab', title: 'Plan v1', url: 'https://notion.so/plan-1', usage: 0 },
    { kind: 'tab', title: 'Plan v2', url: 'https://notion.so/plan-2', usage: 8, sameGroup: true },
    { kind: 'history', title: 'Plan archive', url: 'https://notion.so/plan-0', usage: 1 },
    ...Array.from({ length: 12 }, (_, i) => ({ kind: 'tab', title: `Plan extra ${i}`, url: `https://x.com/${i}`, usage: 0 })),
  ];
  const r = rankResults('plan', items);
  assert.equal(r[0].url, 'https://notion.so/plan-2');
  assert.equal(r.filter((x) => x.kind === 'tab').length, 8);
  const hist = r.findIndex((x) => x.kind === 'history');
  assert.ok(hist === -1 || hist > 0);
});

import { recordAssignments, discoverClusters, suggestChanges, describeUseCase } from '../../src/lib/learn.js';

test('learning: evidence, discovery, suggestions', () => {
  const hl = 3 * DAY;
  let stats = recordAssignments({}, new Map([[1, { name: 'Hiring' }], [2, { name: 'Hiring' }], [3, { name: 'Engineering' }]]), (id) => ({ 1: 'ashby.com', 2: 'linkedin.com', 3: 'github.com/acme/api' })[id], now);
  assert.equal(stats.Hiring.n, 2);
  assert.equal(stats.Hiring.sites['ashby.com'], 1);
  const sites = { 'carta.com': bump(null, 5, now, hl), 'docsend.com': bump(null, 4, now, hl), 'ashby.com': bump(null, 9, now, hl), 'lonely.com': bump(null, 9, now, hl) };
  const pairs = { [pairKey('carta.com', 'docsend.com')]: bump(null, 3, now, hl), [pairKey('ashby.com', 'carta.com')]: bump(null, 3, now, hl) };
  const clusters = discoverClusters({ sites, pairs, covered: new Set(['ashby.com']), now, halfLifeMs: hl });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].sites.sort(), ['carta.com', 'docsend.com']);
  const useCases = [{ name: 'Hiring', description: 'Recruiting' }, { name: 'Sales', description: 'CRM' }];
  stats.Sales = { n: 1, t: now - 30 * DAY, sites: {} };
  for (let i = 0; i < 20; i++) stats = recordAssignments(stats, new Map([[1, { name: 'Hiring' }]]), () => 'ashby.com', now);
  const s = suggestChanges({ useCases, stats, clusters: [{ ...clusters[0], name: 'Fundraising' }], now });
  assert.deepEqual(s.retire, ['Sales']);
  assert.equal(s.add[0].name, 'Fundraising');
  assert.deepEqual(s.enrich.find((e) => e.name === 'Hiring').sites, ['ashby.com', 'linkedin.com']);
  assert.match(describeUseCase({ name: 'Hiring', description: 'Recruiting', sites: ['ashby.com'] }), /Usually on: ashby\.com/);
  const fewer = suggestChanges({ useCases, stats: { Hiring: { n: 3, t: now, sites: {} } }, clusters: [], now });
  assert.deepEqual(fewer.retire, [], 'no retirements without enough evidence');
});

test('grouping requests stay under Jev\'s size limit when there are many goals, and still ask about every tab', () => {
  const settings = { ...DEFAULTS, jevApiKey: 'k' };
  const tabs = Array.from({ length: 53 }, (_, i) => ({ id: i + 1, title: `Loose tab number ${i} about something`, url: `https://site${i % 7}.example.com/page/${i}` }));
  const goals = Array.from({ length: 89 }, (_, i) => ({ name: `Goal ${i + 1}`, samples: [`Sample title ${i} one with some length`, `Sample ${i} two`, `Sample ${i} three`] }));
  const reqs = buildGroupingRequests(tabs, { useCases: DEFAULTS.useCases, goals, settings });
  assert.ok(reqs.length > 3); // 20 per request would be ~300 KB each
  for (const r of reqs) assert.ok(JSON.stringify(r.body).length <= 80000);
  const asked = new Set(reqs.flatMap((r) => Object.values(r.idMap)));
  assert.equal(asked.size, 53);
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `Goal ${i + 1}`, samples: [] }));
  const big = buildGroupingRequests(tabs.slice(0, 2), { useCases: DEFAULTS.useCases, goals: many, settings });
  assert.equal(Object.keys(big[0].body.questions.tab_1.criteria).length, 255); // Jev's Choice limit, with `none` kept
  assert.ok('none' in big[0].body.questions.tab_1.criteria);
  // A handful of options still uses the normal batch size.
  assert.equal(buildGroupingRequests(tabs, { useCases: DEFAULTS.useCases, settings }).length, 3);
});
