// Ask mode: plain-English moves and merges. Pure parsing first, then flows on the fake Chrome.
import { describe, test, expect } from 'vitest';
import { harness } from './harness.js';
import { parseInstruction, resolveGroup, exactSelection, cleanWhat, includeQuestions, lookAlikes, baseName } from '../../src/lib/ask.js';
import { buildMatchRequests, MAX_REQUEST_CHARS } from '../../src/lib/jev.js';
import { DEFAULTS } from '../../src/lib/settings.js';

describe('parseInstruction', () => {
  test.each([
    ['Merge Growth 2 into Growth', { kind: 'merge', from: ['Growth 2'], into: 'Growth' }],
    ['merge Hiring and Interviews', { kind: 'merge', from: ['Hiring', 'Interviews'], into: null }],
    ['Combine Ops, Infra and Oncall into Platform', { kind: 'merge', from: ['Ops', 'Infra', 'Oncall'], into: 'Platform' }],
    ['Move the dashboards and funnel reports into Growth', { kind: 'move', what: 'the dashboards and funnel reports', from: null, into: 'Growth' }],
    ['put the LinkedIn tabs out of Hiring into a new group called Social', { kind: 'move', what: 'the LinkedIn tabs', from: 'Hiring', into: 'Social' }],
    ['Take the LinkedIn tabs out of Hiring', { kind: 'move', what: 'the LinkedIn tabs', from: 'Hiring', into: null }],
    ['please rename Growth 2 to Paid growth', { kind: 'rename', group: 'Growth 2', to: 'Paid growth' }],
    ['Ungroup the Research group', { kind: 'ungroup', group: 'Research' }],
  ])('%s', (text, want) => expect(parseInstruction(text)).toEqual(want));

  test('anything else is unknown', () => {
    expect(parseInstruction('what time is it').kind).toBe('unknown');
    expect(parseInstruction('merge Growth').kind).toBe('unknown');
  });
});

describe('resolving names and picking tabs', () => {
  const groups = [{ id: 1, title: 'Growth', count: 6 }, { id: 2, title: 'Growth 2', count: 4 }, { id: 3, title: 'Hiring', count: 9 }, { id: 4, title: 'Docs', count: 2 }, { id: 5, title: 'Docs', count: 3 }];
  test('exact names win; repeated names are ambiguous; prefixes resolve when unique', () => {
    expect(resolveGroup('growth', groups).match.id).toBe(1);
    expect(resolveGroup('Growth 2', groups).match.id).toBe(2);
    expect(resolveGroup('docs', groups).candidates.map((g) => g.id)).toEqual([4, 5]);
    expect(resolveGroup('hir', groups).match.id).toBe(3);
    expect(resolveGroup('Billing', groups).candidates).toEqual([]);
    expect(baseName('Growth 2')).toBe('growth');
  });
  test('a site name or a group name selects exactly; descriptions need judgment', () => {
    const pool = [
      { id: 10, url: 'https://www.linkedin.com/feed/', title: 'Feed', groupId: 3 },
      { id: 11, url: 'https://www.linkedin.com/in/someone', title: 'Profile', groupId: 3 },
      { id: 12, url: 'https://app.example.com/funnels/1', title: 'Activation funnel', groupId: 2 },
    ];
    expect(cleanWhat('all of the LinkedIn tabs')).toBe('LinkedIn');
    expect(exactSelection('the LinkedIn tabs', pool, groups)).toMatchObject({ tabIds: [10, 11], how: 'site' });
    expect(exactSelection('Growth 2', pool, groups)).toMatchObject({ tabIds: [12], how: 'group' });
    expect(exactSelection('everything', pool, groups).tabIds).toEqual([10, 11, 12]);
    expect(exactSelection('the funnel reports', pool, groups)).toBeNull();
  });
  test('borderline tabs become a few questions, clustered by a shared word', () => {
    const byId = new Map([
      [1, { id: 1, url: 'https://a.example.com/x', title: 'Partner referrals report' }],
      [2, { id: 2, url: 'https://a.example.com/y', title: 'Referrals payouts monthly' }],
      [3, { id: 3, url: 'https://b.example.com/z', title: 'Quarterly plan' }],
    ]);
    const qs = includeQuestions([1, 2, 3], byId);
    expect(qs[0]).toMatchObject({ term: 'referrals', tabIds: [1, 2] });
    expect(qs[1]).toMatchObject({ term: null, tabIds: [3] });
    expect(qs.length).toBeLessThanOrEqual(3);
  });
  test('look-alike groups: same name apart from a number, or shared words', () => {
    const tabsByGroup = new Map([
      [1, [{ url: 'https://a.example.com/1', title: 'Activation funnel' }]],
      [2, [{ url: 'https://a.example.com/2', title: 'Signup funnel' }]],
      [3, [{ url: 'https://c.example.com/3', title: 'Candidate pipeline' }]],
    ]);
    const pairs = lookAlikes(groups.slice(0, 3), tabsByGroup);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].into.id).toBe(1);
    expect(pairs[0].from.id).toBe(2);
  });
  test('Jev match requests: one yes/no per tab, under the size limit', () => {
    const tabs = Array.from({ length: 180 }, (_, i) => ({ id: i + 1, title: `Some tab number ${i} with a longer title here`, url: `https://s${i % 9}.example.com/p/${i}` }));
    const reqs = buildMatchRequests(tabs, { description: 'the funnel reports', target: 'Growth', settings: { ...DEFAULTS } });
    const asked = reqs.flatMap((r) => Object.values(r.idMap));
    expect(asked).toHaveLength(180);
    for (const r of reqs) {
      expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
      expect(Object.values(r.body.questions).every((q) => q.type === 'noul')).toBe(true);
    }
  });
});

describe('Ask on the fake Chrome', () => {
  async function scene(jev) {
    const h = await harness(jev ? { jev } : { settings: { jevApiKey: '' } });
    const ids = {
      f1: await h.fake.open('https://app.example.com/funnels/1', { title: 'Activation funnel · Dashboards' }),
      f2: await h.fake.open('https://app.example.com/funnels/2', { title: 'Weekly signups · Dashboards' }),
      r1: await h.fake.open('https://app.example.com/reports/9', { title: 'Partner referrals · Dashboards' }),
      g1: await h.fake.open('https://docs.example.com/growth-plan', { title: 'Growth plan' }),
      g2: await h.fake.open('https://docs.example.com/growth-ideas', { title: 'Growth ideas' }),
      li1: await h.fake.open('https://www.linkedin.com/feed/', { title: 'Feed | LinkedIn' }),
      li2: await h.fake.open('https://www.linkedin.com/in/someone', { title: 'Someone | LinkedIn' }),
      cand: await h.fake.open('https://ats.example.com/candidates/1', { title: 'Candidate · ATS' }),
    };
    const mk = async (tabIds, title) => { const gid = await h.chrome.tabs.group({ tabIds }); await h.chrome.tabGroups.update(gid, { title }); return gid; };
    const gGrowth = await mk([ids.g1], 'Growth');
    const gGrowth2 = await mk([ids.g2, ids.f2], 'Growth 2');
    const gHiring = await mk([ids.cand, ids.li1, ids.li2], 'Hiring');
    return { h, ids, gGrowth, gGrowth2, gHiring };
  }
  const groupOf = (h, id) => h.fake.allGroups().find((g) => g.id === h.fake.tab(id).groupId)?.title ?? null;

  test('home lists look-alike groups', async () => {
    const { h, gGrowth, gGrowth2 } = await scene();
    const r = await h.send({ type: 'askHome' });
    expect(r.lookAlikes[0]).toMatchObject({ into: { id: gGrowth2 }, from: { id: gGrowth } });
  });

  test('a clear merge happens at once, and undo puts both groups back', async () => {
    const { h, ids } = await scene();
    const r = await h.send({ type: 'ask', text: 'Merge Growth 2 into Growth' });
    expect(r.done).toMatchObject({ merged: 1, moved: 2, name: 'Growth', count: 3, message: 'Merged Growth 2 into Growth. It now has 3 tabs.' });
    expect(groupOf(h, ids.g2)).toBe('Growth');
    expect(h.fake.allGroups().some((g) => g.title === 'Growth 2')).toBe(false);
    const u = await h.send({ type: 'askUndo' });
    expect(u.restored).toBe(2);
    expect(groupOf(h, ids.g2)).toBe('Growth 2');
    expect(groupOf(h, ids.f2)).toBe('Growth 2');
    expect(groupOf(h, ids.g1)).toBe('Growth');
  });

  test('site tabs out of one group into a new one, at once; taking them out ungroups', async () => {
    const { h, ids } = await scene();
    const r = await h.send({ type: 'ask', text: 'Move the LinkedIn tabs out of Hiring into Social' });
    expect(r.done).toMatchObject({ moved: 2, name: 'Social', isNew: true });
    expect(groupOf(h, ids.li1)).toBe('Social');
    expect(groupOf(h, ids.cand)).toBe('Hiring');
    await h.send({ type: 'askUndo' });
    expect(groupOf(h, ids.li1)).toBe('Hiring');
    const out = await h.send({ type: 'ask', text: 'Take the LinkedIn tabs out of Hiring' });
    expect(out.done.ungrouped).toBe(2);
    expect(groupOf(h, ids.li2)).toBe(null);
  });

  test('rename and ungroup', async () => {
    const { h, ids } = await scene();
    expect((await h.send({ type: 'ask', text: 'rename Growth 2 to Paid growth' })).done.renamed).toEqual({ from: 'Growth 2', to: 'Paid growth' });
    expect(groupOf(h, ids.g2)).toBe('Paid growth');
    await h.send({ type: 'askUndo' });
    expect(groupOf(h, ids.g2)).toBe('Growth 2');
    expect((await h.send({ type: 'ask', text: 'ungroup Hiring' })).done.ungrouped).toBe(3);
  });

  test('a description goes to Jev: sure tabs move, borderline ones become a question, then a preview', async () => {
    const jev = (body) => {
      if (!body) return { data: [] };
      const answers = {};
      for (const [q, spec] of Object.entries(body.questions)) {
        const n = q.split('_')[1];
        const line = body.state.split('\n').find((l) => l.startsWith(`[${n}]`)) || '';
        answers[q] = { noul: /funnel|signups/i.test(line) ? 0.92 : /referrals/i.test(line) ? 0.5 : 0.05 };
        expect(spec.type).toBe('noul');
      }
      return { answers };
    };
    const { h, ids, gGrowth } = await scene(jev);
    const r = await h.send({ type: 'ask', text: 'Move the dashboards and funnel reports into Growth' });
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0].kind).toBe('include');
    expect(r.questions[0].samples).toEqual(['Partner referrals · Dashboards']);
    const a = await h.send({ type: 'askAnswer', session: r.session, answers: { [r.questions[0].id]: 'yes' } });
    expect(a.preview.target).toMatchObject({ name: 'Growth', isNew: false });
    expect(a.preview.tabs.map((t) => [t.id, t.section]).sort()).toEqual([[ids.f1, 'fit'], [ids.f2, 'fit'], [ids.r1, 'yes']].sort());
    const done = await h.send({ type: 'askApply', plan: a.preview.plan });
    expect(done.done).toMatchObject({ moved: 3, groupId: gGrowth, count: 4 });
    expect(groupOf(h, ids.r1)).toBe('Growth');
    expect(groupOf(h, ids.g2)).toBe('Growth 2'); // not part of the description
  });

  test('two groups with the same name: asks which, and can merge them', async () => {
    const { h, ids } = await scene();
    await h.chrome.tabGroups.update(h.fake.tab(ids.g2).groupId, { title: 'Growth' });
    const r = await h.send({ type: 'ask', text: 'Move the LinkedIn tabs into Growth' });
    expect(r.questions.map((q) => q.kind)).toEqual(['target']);
    expect(r.questions[0].options[0].value).toBe('merge');
    const a = await h.send({ type: 'askAnswer', session: r.session, answers: { target: 'merge' } });
    expect(a.preview.merging).toHaveLength(1);
    expect(a.preview.total).toBe(3);
    const done = await h.send({ type: 'askApply', plan: a.preview.plan });
    expect(done.done.count).toBe(5);
    expect(h.fake.allGroups().filter((g) => g.title === 'Growth')).toHaveLength(1);
  });

  test('without Jev, words decide, and nothing happens without a check', async () => {
    const { h, ids } = await scene();
    const r = await h.send({ type: 'ask', text: 'Move the funnel tabs into Growth' });
    expect(r.preview.tabs.map((t) => t.id).sort()).toEqual([ids.f1, ids.f2].sort()); // both have /funnels/ in the address
    expect(groupOf(h, ids.f1)).toBe(null);
  });

  test('unknown instructions and missing groups explain themselves', async () => {
    const { h } = await scene();
    expect((await h.send({ type: 'ask', text: 'hello' })).reply).toMatch(/move, merge, rename and ungroup/);
    expect((await h.send({ type: 'ask', text: 'merge Billing into Growth' })).reply).toMatch(/can't find a group called “Billing”/);
    expect((await h.send({ type: 'askUndo' })).restored).toBe(0);
  });

  test('tabs in other windows come along into the target window', async () => {
    const { h, ids, gGrowth } = await scene();
    const w = await h.chrome.windows.create({});
    const far = await h.fake.open('https://www.linkedin.com/in/another', { title: 'Another | LinkedIn', windowId: w.id });
    const r = await h.send({ type: 'ask', text: 'move the linkedin tabs into Growth' });
    expect(r.done.moved).toBe(3);
    expect(h.fake.tab(far).groupId).toBe(gGrowth);
    expect(h.fake.tab(far).windowId).toBe(h.fake.tab(ids.g1).windowId);
    await h.send({ type: 'askUndo' });
    expect(h.fake.tab(far).windowId).toBe(w.id);
  });
});
