// Goal grouping: the job a set of tabs serves, not the site they're on.
import { describe, test, expect } from 'vitest';
import { goalGraph, clusterGoals, nameGoal, stableName, tabTerms } from '../../src/lib/goals.js';
import { buildLineage } from '../../src/lib/lineage.js';
import { bump, pairKey, DAY } from '../../src/lib/scoring.js';
import { normalizeUrl } from '../../src/lib/url.js';
import { buildGoalRequests, parseGoalResponses } from '../../src/lib/jev.js';
import { DEFAULTS } from '../../src/lib/settings.js';
import { harness, MIN } from './harness.js';

const now = Date.UTC(2026, 9, 18, 16);
let next = 1;
const T = (url, title, o = {}) => ({ id: next++, url, title, windowId: 1, index: next, openedAt: 0, ...o });

function workday() {
  next = 1;
  return [
    T('https://linear.app/acme/issue/ENG-482/billing-retry-fails', 'ENG-482 Billing retry fails for NJ claims'),
    T('https://github.com/acme/api/pull/91', 'Fix billing retry backoff (ENG-482) · Pull Request #91 · acme/api'),
    T('https://docs.google.com/document/d/abc', 'Billing retry runbook - Google Docs'),
    T('https://github.com/acme/web/pull/5', 'Update marketing footer · Pull Request #5 · acme/web'),
    T('https://github.com/acme/web/pull/6', 'Bump eslint to v10 · Pull Request #6 · acme/web'),
    T('https://app.ashbyhq.com/candidates/123', 'Jane Doe – Senior Therapist – Ashby'),
    T('https://www.linkedin.com/in/janedoe', 'Jane Doe | LinkedIn'),
    T('https://mail.google.com/mail/u/0/#inbox/abc', 'Interview: Jane Doe, Senior Therapist - Gmail'),
    T('https://www.youtube.com/watch?v=1', 'lofi beats to code to - YouTube'),
  ];
}
const titlesOf = (tabs, ids) => ids.map((id) => tabs.find((t) => t.id === id).title);

describe('goal clustering (pure)', () => {
  test('one incident across four tools is one goal; unrelated PRs in the same repo are not', () => {
    const tabs = workday();
    const g = goalGraph(tabs, { edges: buildLineage(tabs) });
    const clusters = clusterGoals(tabs.map((t) => t.id), g.w);
    const names = clusters.map((c) => nameGoal(c, g.docs, g.idf));
    expect(names).toContain('ENG-482 Billing Retry');
    expect(names).toContain('Jane Doe');
    const incident = clusters[names.indexOf('ENG-482 Billing Retry')];
    expect(titlesOf(tabs, incident)).toHaveLength(3);
    expect(clusters.some((c) => c.includes(4) && c.includes(5))).toBe(false); // same repo, different jobs
    expect(clusters.some((c) => c.includes(9))).toBe(false);
  });

  test('the same site alone is not evidence', () => {
    next = 1;
    const tabs = [T('https://github.com/acme/api/pull/1', 'Add retries'), T('https://github.com/acme/api/pull/2', 'Rename module')];
    const g = goalGraph(tabs);
    expect(g.w(1, 2)).toBeLessThan(0.1);
  });

  test('switching between two tabs with nothing in common still makes them a goal', () => {
    next = 1;
    const tabs = [T('https://figma.com/file/x/Onboarding-v3', 'Onboarding v3'), T('https://linear.app/acme/issue/DES-9', 'Signup flow polish')];
    const hl = 3 * DAY;
    const tabPairs = { [pairKey(normalizeUrl(tabs[0].url), normalizeUrl(tabs[1].url))]: bump(null, 4, now, hl) };
    const g = goalGraph(tabs, { tabPairs, now, halfLifeMs: hl });
    expect(g.why(1, 2).together).toBeGreaterThan(0.6);
    expect(clusterGoals([1, 2], g.w)).toEqual([[1, 2]]);
    expect(nameGoal([1, 2], g.docs, g.idf)).toBeNull(); // nothing shared: Jev or a fallback names it
  });

  test('opener lineage counts; same-site guesses barely count', () => {
    next = 1;
    const tabs = [T('https://slack.com/archives/C1/p1', 'thread'), T('https://notion.so/acme/Plan', 'Q4 plan', { parentTabId: 1 })];
    expect(goalGraph(tabs, { edges: buildLineage(tabs) }).why(1, 2).lineage).toBeGreaterThan(0.5);
    next = 1;
    const same = [T('https://example.com/list', 'List'), T('https://example.com/list/item', 'Item')];
    expect(goalGraph(same, { edges: buildLineage(same) }).why(1, 2).lineage).toBeLessThan(0.15);
  });

  test('a shared identifier links tabs with different words', () => {
    next = 1;
    const tabs = [T('https://zendesk.example/tickets/1', 'Customer cannot log in (OPS-12)'), T('https://jira.example/browse/OPS-12', 'Auth token expiry')];
    expect(goalGraph(tabs).why(1, 2).entity).toBe(0.5);
  });

  test('average linkage stops chains: A–B and C–D stay apart even though B–C touch', () => {
    const w = (a, b) => ({ '1|2': 1, '3|4': 1, '2|3': 0.9 })[a < b ? `${a}|${b}` : `${b}|${a}`] || 0;
    expect(clusterGoals([1, 2, 3, 4], w).map((c) => c.sort())).toEqual([[1, 2], [3, 4]]);
  });

  test('cluster size is capped', () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const clusters = clusterGoals(ids, () => 1, { maxSize: 8 });
    expect(Math.max(...clusters.map((c) => c.length))).toBeLessThanOrEqual(8);
  });

  test('names: identifier first, words in reading order, years are not identifiers', () => {
    const d = tabTerms({ url: 'https://x.example/2026/report', title: 'Q3 2026 board deck' });
    expect([...d.entities]).toEqual([]);
    expect(d.terms.has('board')).toBe(true);
  });

  test('a goal keeps its existing group name across runs', () => {
    const byId = new Map([[1, { groupId: 7 }], [2, { groupId: 7 }], [3, { groupId: -1 }]]);
    expect(stableName([1, 2, 3], byId, new Map([[7, 'Billing Retry']]), new Set(['billing retry']))).toBe('Billing Retry');
    expect(stableName([1, 2, 3], byId, new Map([[7, 'Mine']]), new Set())).toBeNull(); // a manual group isn't ours to reuse
  });

  test('Jev goal requests: verification, member checks for 3+, a name only when needed', () => {
    next = 1;
    const tabs = workday().slice(0, 3);
    const [r] = buildGoalRequests([{ tabs, needName: true }], { settings: DEFAULTS, exclude: ['Hiring'] });
    expect(r.body.questions.goal.type).toBe('noul');
    expect(Object.keys(r.body.questions).filter((k) => k.startsWith('member_'))).toHaveLength(3);
    expect(Object.values(r.body.questions.name.criteria).some((c) => c.startsWith('Hiring:'))).toBe(false);
    const [r2] = buildGoalRequests([{ tabs: tabs.slice(0, 2) }], { settings: DEFAULTS });
    expect(r2.body.questions.name).toBeUndefined();
    expect(r2.body.questions.member_1).toBeUndefined();
    const key = Object.keys(r.nameOptions).find((k) => r.nameOptions[k] === 'Incidents');
    const [a] = parseGoalResponses([r], [{ answers: { goal: { noul: 0.8 }, member_1: { noul: 0.9 }, member_2: { noul: 0.1 }, name: { choice: key } } }]);
    expect(a).toEqual({ p: 0.8, members: new Map([[1, 0.9], [2, 0.1]]), name: 'Incidents' });
  });
});

describe('goal grouping (background)', () => {
  async function openWorkday(h) {
    const ids = {};
    ids.issue = await h.fake.open('https://linear.app/acme/issue/ENG-482/billing-retry-fails', { title: 'ENG-482 Billing retry fails for NJ claims' });
    ids.pr = await h.fake.open('https://github.com/acme/api/pull/91', { title: 'Fix billing retry backoff (ENG-482) · Pull Request #91 · acme/api', from: ids.issue });
    ids.doc = await h.fake.open('https://docs.google.com/document/d/abc', { title: 'Billing retry runbook - Google Docs' });
    ids.web5 = await h.fake.open('https://github.com/acme/web/pull/5', { title: 'Update marketing footer · Pull Request #5 · acme/web' });
    ids.web6 = await h.fake.open('https://github.com/acme/web/pull/6', { title: 'Bump eslint to v10 · Pull Request #6 · acme/web' });
    ids.ats = await h.fake.open('https://app.ashbyhq.com/candidates/123', { title: 'Jane Doe – Senior Therapist – Ashby' });
    ids.li = await h.fake.open('https://www.linkedin.com/in/janedoe', { title: 'Jane Doe | LinkedIn', from: ids.ats });
    return ids;
  }
  const groupOf = (h, id) => h.fake.allGroups().find((g) => g.id === h.fake.tab(id).groupId)?.title;

  test('without Jev: goals form across sites, named from shared title terms; no site groups', async () => {
    const h = await harness({ settings: { jevApiKey: '' } });
    const ids = await openWorkday(h);
    const r = await h.send({ type: 'group' });
    expect(r.mode).toBe('goals');
    expect(groupOf(h, ids.issue)).toBe('ENG-482 Billing Retry');
    expect(groupOf(h, ids.pr)).toBe('ENG-482 Billing Retry');
    expect(groupOf(h, ids.doc)).toBe('ENG-482 Billing Retry');
    expect(groupOf(h, ids.ats)).toBe('Jane Doe');
    expect(groupOf(h, ids.li)).toBe('Jane Doe');
    expect(groupOf(h, ids.web5)).toBeUndefined();
    expect(h.fake.allGroups().map((g) => g.title)).not.toContain('GitHub');
  });

  test('Jev rejects a weak goal and prunes an outlier; leftovers can join a goal', async () => {
    const jev = (body) => {
      const answers = {};
      const state = body.state;
      for (const [q, spec] of Object.entries(body.questions)) {
        if (q === 'goal') answers[q] = { noul: /Jane Doe/.test(state) ? 0.2 : 0.9 };
        else if (q.startsWith('member_')) answers[q] = { noul: /runbook/.test(state.split('\n').find((l) => l.startsWith(`[${q.split('_')[1]}]`))) ? 0.1 : 0.9 };
        else if (spec.type === 'choice') {
          const line = state.split('\n').find((l) => l.startsWith(`[${q.split('_')[1]}]`)) || '';
          const goalKey = Object.keys(spec.criteria).find((k) => spec.criteria[k].startsWith('ENG-482'));
          answers[q] = /footer/.test(line) && goalKey ? { choice: goalKey, confidence: 0.9 } : { choice: 'none', confidence: 0.9 };
        } else answers[q] = { noul: 0.5 };
      }
      return { answers };
    };
    const h = await harness({ jev });
    const ids = await openWorkday(h);
    const r = await h.send({ type: 'group' });
    expect(r.via).toBe('jev');
    expect(groupOf(h, ids.ats)).toBeUndefined();   // Jev said not one goal
    expect(groupOf(h, ids.doc)).toBeUndefined();   // pruned as an outlier
    expect(groupOf(h, ids.issue)).toBe('ENG-482 Billing Retry');
    expect(groupOf(h, ids.web5)).toBe('ENG-482 Billing Retry'); // a leftover Jev placed into the goal
  });

  test('Jev names a goal whose tabs share no words', async () => {
    const jev = (body) => {
      const answers = {};
      for (const [q, spec] of Object.entries(body.questions)) {
        if (q === 'name') answers[q] = { choice: Object.keys(spec.criteria).find((k) => spec.criteria[k].startsWith('Design:')), confidence: 0.8 };
        else if (spec.type === 'choice') answers[q] = { choice: 'none', confidence: 0.9 };
        else answers[q] = { noul: 0.9 };
      }
      return { answers };
    };
    const h = await harness({ jev });
    const f = await h.fake.open('https://figma.com/file/x/Onboarding-v3', { title: 'Onboarding v3' });
    const l = await h.fake.open('https://linear.app/acme/issue/DES-9', { title: 'Signup flow polish' });
    for (let i = 0; i < 4; i++) { await h.fake.activate(f); h.clock.advance(MIN); await h.fake.activate(l); h.clock.advance(MIN); }
    await h.send({ type: 'group' });
    expect(groupOf(h, f)).toBe('Design');
    expect(groupOf(h, l)).toBe('Design');
  });

  test('names stay stable from run to run', async () => {
    const h = await harness({ settings: { jevApiKey: '' } });
    const ids = await openWorkday(h);
    await h.send({ type: 'group' });
    await h.fake.navigate(ids.doc, 'https://docs.google.com/document/d/abc', { title: 'Billing retry runbook v2 - Google Docs' });
    await h.send({ type: 'group' });
    expect(h.fake.allGroups().filter((g) => g.title === 'ENG-482 Billing Retry')).toHaveLength(1);
  });

  test('use-case evidence for learning ignores goal groups', async () => {
    const h = await harness({ settings: { jevApiKey: '' } });
    await openWorkday(h);
    await h.send({ type: 'group' });
    expect(h.ctx.state.useCaseStats['ENG-482 Billing Retry']).toBeUndefined();
  });

  test('page text (opt-in, local) links tabs whose titles differ; excluded domains are never read', async () => {
    const h = await harness({ settings: { jevApiKey: '', readPageText: true, aiExcludedDomains: ['ehr.example'] } });
    h.fake.permissions = new Set(['scripting', '<all_urls>']);
    const read = [];
    const a = await h.fake.open('https://vendor-a.example/quote', { title: 'Quote #A' });
    const b = await h.fake.open('https://vendor-b.example/pricing', { title: 'Pricing' });
    const e = await h.fake.open('https://ehr.example/chart', { title: 'Chart' });
    h.fake.scriptResults = (tabId) => { read.push(tabId); return tabId === e ? 'secret' : 'Clinician scheduling software evaluation for Emora clinicians scheduling'; };
    await h.send({ type: 'group' });
    expect(read).not.toContain(e);
    expect(groupOf(h, a)).toBeTruthy();
    expect(groupOf(h, a)).toBe(groupOf(h, b));
  });
});

test('an owner/repo in a title is location, even on hosts Tab Land does not know', () => {
  const d = tabTerms({ url: 'https://git.internal.example/acme/api/pull/91', title: 'Fix billing retry · Pull Request #91 · acme/api' });
  expect(d.terms.has('acme')).toBe(false);
  expect(d.terms.has('api')).toBe(false);
  expect(d.terms.has('billing')).toBe(true);
});

describe('regroup everything (one-time rebuild)', () => {
  const choose = (prefix) => (body) => {
    const answers = {};
    for (const [q, spec] of Object.entries(body.questions)) {
      if (spec.type === 'choice') {
        const line = (body.state.split('\n').find((l) => l.startsWith(`[${q.split('_')[1]}]`)) || '').toLowerCase();
        const want = /ashby|linkedin|jane/.test(line) ? 'Hiring:' : prefix;
        const k = Object.keys(spec.criteria).find((x) => spec.criteria[x].startsWith(want)) || 'none';
        answers[q] = { choice: k, confidence: 0.9 };
      } else answers[q] = { noul: 0.9 };
    }
    return { answers };
  };
  async function useCaseDay() {
    const h = await harness({ jev: choose('Engineering:'), settings: { groupingMode: 'useCases' } });
    const ids = {};
    ids.issue = await h.fake.open('https://linear.app/acme/issue/ENG-482/billing-retry-fails', { title: 'ENG-482 Billing retry fails for NJ claims' });
    ids.pr = await h.fake.open('https://github.com/acme/api/pull/91', { title: 'Fix billing retry backoff (ENG-482) · Pull Request #91 · acme/api', from: ids.issue });
    ids.doc = await h.fake.open('https://docs.google.com/document/d/abc', { title: 'Billing retry runbook - Google Docs' });
    ids.web = await h.fake.open('https://github.com/acme/web/pull/5', { title: 'Update marketing footer · Pull Request #5 · acme/web' });
    ids.ats = await h.fake.open('https://app.ashbyhq.com/candidates/123', { title: 'Jane Doe – Senior Therapist – Ashby' });
    ids.li = await h.fake.open('https://www.linkedin.com/in/janedoe', { title: 'Jane Doe | LinkedIn', from: ids.ats });
    ids.mine1 = await h.fake.open('https://news.example/a', { title: 'Weekend reading' });
    ids.mine2 = await h.fake.open('https://news.example/b', { title: 'Another read' });
    const mine = await h.chrome.tabs.group({ tabIds: [ids.mine1, ids.mine2] });
    await h.chrome.tabGroups.update(mine, { title: 'My reads', color: 'pink' });
    await h.send({ type: 'group' });
    return { h, ids, mine };
  }
  const titleOf = (h, id) => h.fake.allGroups().find((g) => g.id === h.fake.tab(id).groupId)?.title;
  const layout = (h) => h.fake.allGroups().map((g) => [g.title, h.fake.allTabs().filter((t) => t.groupId === g.id).map((t) => t.url).sort()]).sort();

  test('switching to goals and regrouping replaces use-case groups with goals; your own group stays', async () => {
    const { h, ids, mine } = await useCaseDay();
    expect(titleOf(h, ids.issue)).toBe('Engineering');
    await h.chrome.storage.local.set({ settings: { ...(await h.ctx.refreshSettings()), groupingMode: 'goals' } });
    const r = await h.send({ type: 'regroup' });
    expect(r.mode).toBe('goals');
    expect(r.ungrouped).toBeGreaterThan(0);
    expect(titleOf(h, ids.issue)).toBe('ENG-482 Billing Retry');
    expect(titleOf(h, ids.pr)).toBe('ENG-482 Billing Retry');
    expect(titleOf(h, ids.doc)).toBe('ENG-482 Billing Retry');
    expect(titleOf(h, ids.ats)).toBe('Jane Doe');
    expect(h.fake.allGroups().find((g) => g.id === mine)?.title).toBe('My reads');
    expect((await h.send({ type: 'regroupState' })).canUndo).toBe(true);
  });

  test('undo restores the previous groups exactly, then clears itself', async () => {
    const { h } = await useCaseDay();
    const before = layout(h);
    await h.chrome.storage.local.set({ settings: { ...(await h.ctx.refreshSettings()), groupingMode: 'goals' } });
    await h.send({ type: 'regroup' });
    expect(layout(h)).not.toEqual(before);
    const u = await h.send({ type: 'undoRegroup' });
    expect(u.restored).toBeGreaterThan(0);
    expect(layout(h)).toEqual(before);
    expect((await h.send({ type: 'regroupState' })).canUndo).toBe(false);
  });

  test('undo skips tabs closed since, and never pulls tabs out of a group you made afterwards', async () => {
    const { h, ids } = await useCaseDay();
    await h.chrome.storage.local.set({ settings: { ...(await h.ctx.refreshSettings()), groupingMode: 'goals' } });
    await h.send({ type: 'regroup' });
    await h.fake.closeBehindOurBack(ids.web);
    const g = await h.chrome.tabs.group({ tabIds: [ids.ats, ids.li] });
    await h.chrome.tabGroups.update(g, { title: 'Call prep' });
    const u = await h.send({ type: 'undoRegroup' });
    expect(u.error).toBeUndefined();
    expect(titleOf(h, ids.issue)).toBe('Engineering');
    expect(titleOf(h, ids.ats)).toBe('Call prep');
  });

  test('including your own groups regroups them too, and undo gives them back as yours', async () => {
    const { h, ids } = await useCaseDay();
    await h.chrome.storage.local.set({ settings: { ...(await h.ctx.refreshSettings()), groupingMode: 'goals' } });
    await h.send({ type: 'regroup', includeManual: true });
    expect(titleOf(h, ids.mine1)).not.toBe('My reads');
    await h.send({ type: 'undoRegroup' });
    expect(titleOf(h, ids.mine1)).toBe('My reads');
    expect(h.ctx.state.managedGroups.map((n) => n.toLowerCase())).not.toContain('my reads');
  });

  test('the regroup shortcut runs it', async () => {
    const { h, ids } = await useCaseDay();
    await h.chrome.storage.local.set({ settings: { ...(await h.ctx.refreshSettings()), groupingMode: 'goals' } });
    await h.chrome.commands.onCommand.dispatch('regroup-all');
    expect(titleOf(h, ids.issue)).toBe('ENG-482 Billing Retry');
  });
});

describe('fewer, fuller groups', () => {
  test('consolidate merges a small goal into the one it fits, and drops one that fits nowhere', async () => {
    const { consolidate } = await import('../../src/lib/goals.js');
    const docs = new Map([1, 2, 3, 4, 5, 6, 7].map((id) => [id, { terms: new Map([[id <= 6 ? 'billing' : 'garden', 1]]), entities: new Set() }]));
    const graph = { docs, idf: () => 1, w: (a, b) => (a <= 6 && b <= 6 ? 0.5 : 0) };
    const out = consolidate([{ ids: [1, 2, 3, 4] }, { ids: [5, 6] }, { ids: [7] }], graph, { minSize: 4, merge: 0.12, mergedMax: 24 });
    expect(out.map((g) => g.ids.sort())).toEqual([[1, 2, 3, 4, 5, 6]]);
  });
  test('goals with the same name merge instead of becoming "Growth 2"', async () => {
    const { mergeSameNames } = await import('../../src/bg/grouping.js');
    const out = mergeSameNames([{ name: 'Growth', ids: [1, 2] }, { name: 'Hiring', ids: [3] }, { name: 'growth', ids: [4] }, { name: 'Growth 2', ids: [5] }]);
    expect(out).toEqual([{ name: 'Growth', ids: [1, 2, 4, 5] }, { name: 'Hiring', ids: [3] }]);
  });
  test('Group folds older "Growth" / "Growth 2" Tab Land groups into one, and leaves your own alone', async () => {
    const h = await harness({ settings: { jevApiKey: '' } });
    const a = await h.fake.open('https://a.example.com/1', { title: 'One' });
    const b = await h.fake.open('https://a.example.com/2', { title: 'Two' });
    const c = await h.fake.open('https://a.example.com/3', { title: 'Three' });
    const d = await h.fake.open('https://a.example.com/4', { title: 'Four' });
    const mk = async (ids, title) => { const gid = await h.chrome.tabs.group({ tabIds: ids }); await h.chrome.tabGroups.update(gid, { title }); return gid; };
    await mk([a], 'Growth'); await mk([b], 'Growth 2'); await mk([c], 'Notes'); await mk([d], 'Notes 2');
    h.ctx.state.managedGroups.push('Growth', 'Growth 2');
    await h.send({ type: 'group' });
    const titles = h.fake.allGroups().map((g) => g.title).sort();
    expect(titles).toEqual(['Growth', 'Notes', 'Notes 2']);
    expect(h.fake.tab(a).groupId).toBe(h.fake.tab(b).groupId);
  });
  test('with a minimum of 4, Group makes no 2–3 tab groups', async () => {
    const h = await harness({ settings: { jevApiKey: '', minGroupSize: 4 } });
    await h.fake.open('https://linear.app/acme/issue/ENG-482/billing-retry-fails', { title: 'ENG-482 Billing retry fails for NJ claims' });
    await h.fake.open('https://github.com/acme/api/pull/91', { title: 'Fix billing retry backoff (ENG-482) · Pull Request #91 · acme/api' });
    await h.fake.open('https://docs.google.com/document/d/abc', { title: 'Billing retry runbook - Google Docs' });
    const r = await h.send({ type: 'group' });
    expect(r.groups).toEqual([]);
    expect(h.fake.allGroups()).toHaveLength(0);
  });
});
