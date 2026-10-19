// Ask mode: Jev reads the request (typed questions), code carries it out. Pure helpers first, then
// flows on the fake Chrome with a fake Jev that answers the routing questions.
import { describe, test, expect } from 'vitest';
import { harness } from './harness.js';
import { nameSpans, readChoice, includeQuestions, lookAlikes, baseName, ACTIONS } from '../../src/lib/ask.js';
import { buildMatchRequests, buildRouteRequest, MAX_REQUEST_CHARS } from '../../src/lib/jev.js';
import { DEFAULTS } from '../../src/lib/settings.js';

describe('pure helpers', () => {
  test('name candidates are runs of the typed words, quoted text first, no filler at the ends', () => {
    const spans = nameSpans('Rename Growth 2 to "Paid growth" please');
    expect(spans[0]).toBe('Paid growth');
    expect(spans).toContain('Growth 2');
    expect(spans).not.toContain('to');
    expect(spans.every((x) => !/^(to|the|please)\b/i.test(x))).toBe(true);
  });
  test('readChoice keeps the likeliest few options for asking back', () => {
    const c = readChoice({ choice: 'g1', confidence: 0.5, probabilities: { g1: 0.5, g2: 0.4, none: 0.05 } });
    expect(c).toEqual({ key: 'g1', confidence: 0.5, top: [['g1', 0.5], ['g2', 0.4]] });
    expect(readChoice(null)).toBeNull();
  });
  test('baseName strips a trailing number', () => expect(baseName('Growth 2')).toBe('growth'));
  test('borderline tabs become a few questions, clustered by a shared word', () => {
    const byId = new Map([
      [1, { id: 1, url: 'https://a.example.com/x', title: 'Partner referrals report' }],
      [2, { id: 2, url: 'https://a.example.com/y', title: 'Referrals payouts monthly' }],
      [3, { id: 3, url: 'https://b.example.com/z', title: 'Quarterly plan' }],
    ]);
    const qs = includeQuestions([1, 2, 3], byId);
    expect(qs[0]).toMatchObject({ term: 'referrals', tabIds: [1, 2] });
    expect(qs[1]).toMatchObject({ term: null, tabIds: [3] });
  });
  test('look-alike groups: same name apart from a number, or shared words', () => {
    const groups = [{ id: 1, title: 'Growth', count: 6 }, { id: 2, title: 'Growth 2', count: 4 }, { id: 3, title: 'Hiring', count: 9 }];
    const tabsByGroup = new Map([[1, [{ url: 'https://a.example.com/1', title: 'Activation funnel' }]], [2, [{ url: 'https://a.example.com/2', title: 'Signup funnel' }]], [3, [{ url: 'https://c.example.com/3', title: 'Candidate pipeline' }]]]);
    expect(lookAlikes(groups, tabsByGroup)).toEqual([{ into: groups[0], from: groups[1] }]);
  });
  test('the routing request asks everything at once and stays inside Jev limits', () => {
    const groups = Array.from({ length: 120 }, (_, i) => ({ id: 100 + i, title: `Group ${i}`, count: 3, examples: ['One example title', 'Another'] }));
    const req = buildRouteRequest('move linked in out of Growth', { groups, spans: nameSpans('move linked in out of Growth'), actions: ACTIONS, settings: { ...DEFAULTS } });
    const q = req.body.questions;
    expect(Object.keys(q).filter((k) => !k.startsWith('merge_'))).toEqual(['action', 'destination', 'subject', 'new_name']);
    expect(Object.keys(q.destination.criteria).length).toBeLessThanOrEqual(255);
    expect(Object.keys(q).filter((k) => k.startsWith('merge_'))).toHaveLength(120);
    expect(JSON.stringify(req.body).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
    expect(req.gKey.get('g1')).toBe(100);
  });
  test('tab match requests: one yes/no per tab, under the size limit', () => {
    const tabs = Array.from({ length: 180 }, (_, i) => ({ id: i + 1, title: `Some tab number ${i} with a longer title here`, url: `https://s${i % 9}.example.com/p/${i}` }));
    const reqs = buildMatchRequests(tabs, { description: 'the funnel reports', target: 'Growth', settings: { ...DEFAULTS } });
    expect(reqs.flatMap((r) => Object.values(r.idMap))).toHaveLength(180);
    for (const r of reqs) expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
  });
});

/**
 * A fake Jev for Ask. `route` says what it "understood":
 *   {action, destination: title|'new'|'none', subject: title|'none', name: span|'none', merge: [titles],
 *    tabs: (line) => p, conf: {action, destination, subject, name}, probs: {destination: {title: p}}}
 */
function askJev(route) {
  const conf = { action: 0.95, destination: 0.95, subject: 0.95, name: 0.95, ...route.conf };
  const keyFor = (criteria, want) => {
    if (want === 'new' || want === 'none') return want;
    return Object.keys(criteria).find((k) => criteria[k].startsWith(`"${want}"`)) || 'none';
  };
  return (body) => {
    if (!body) return { data: [] };
    const answers = {};
    for (const [q, spec] of Object.entries(body.questions)) {
      if (q === 'action') answers[q] = { choice: route.action, confidence: conf.action, probabilities: route.actionProbs || { [route.action]: conf.action } };
      else if (q === 'destination' || q === 'subject') {
        const k = keyFor(spec.criteria, route[q] ?? 'none');
        const extra = Object.fromEntries(Object.entries(route.probs?.[q] || {}).map(([t, p]) => [keyFor(spec.criteria, t), p]));
        answers[q] = { choice: k, confidence: conf[q], probabilities: { [k]: conf[q], ...extra } };
      } else if (q === 'new_name') {
        const k = Object.keys(spec.criteria).find((x) => spec.criteria[x] === `"${route.name}"`) || 'none';
        answers[q] = { choice: k, confidence: conf.name };
      } else if (q.startsWith('merge_')) {
        answers[q] = { noul: (route.merge || []).some((t) => spec.instructions.includes(`("${t}")`)) ? 0.9 : 0.05 };
      } else if (q.startsWith('tab_')) {
        const n = q.split('_')[1];
        const line = body.state.split('\n').find((l) => l.startsWith(`[${n}]`)) || '';
        answers[q] = { noul: route.tabs ? route.tabs(line) : 0.05 };
      }
    }
    return { answers };
  };
}

describe('Ask on the fake Chrome', () => {
  async function scene(route, settings = {}) {
    const h = await harness({ jev: askJev(route), settings });
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
    const g = {
      growth: await mk([ids.g1, ids.li1], 'Growth'),
      growth2: await mk([ids.g2, ids.f2], 'Growth 2'),
      hiring: await mk([ids.cand, ids.li2], 'Hiring'),
    };
    return { h, ids, g };
  }
  const groupOf = (h, id) => h.fake.allGroups().find((x) => x.id === h.fake.tab(id).groupId)?.title ?? null;
  const linkedin = (line) => (/linkedin/i.test(line) ? 0.93 : 0.03);

  test('loose wording with typos: "Can hyou move linked in out of Growth" takes the LinkedIn tab out', async () => {
    const { h, ids } = await scene({ action: 'take_out', subject: 'Growth', tabs: linkedin });
    const r = await h.send({ type: 'ask', text: 'Can hyou move linked in out of Growth' });
    expect(r.done).toMatchObject({ ungrouped: 1 });
    expect(groupOf(h, ids.li1)).toBe(null);
    expect(groupOf(h, ids.li2)).toBe('Hiring'); // only out of Growth
    expect(groupOf(h, ids.g1)).toBe('Growth');
    await h.send({ type: 'askUndo' });
    expect(groupOf(h, ids.li1)).toBe('Growth');
  });

  test('a merge Jev is sure of happens at once, and undo puts both groups back', async () => {
    const { h, ids, g } = await scene({ action: 'merge', destination: 'Growth', merge: ['Growth 2'] });
    const r = await h.send({ type: 'ask', text: 'fold growth 2 into growth' });
    expect(r.done).toMatchObject({ merged: 1, moved: 2, name: 'Growth', count: 4, message: 'Merged Growth 2 into Growth. It now has 4 tabs.' });
    expect(groupOf(h, ids.f2)).toBe('Growth');
    expect((await h.send({ type: 'askUndo' })).restored).toBe(2);
    expect(groupOf(h, ids.f2)).toBe('Growth 2');
    expect(h.fake.allGroups().map((x) => x.id)).toContain(g.growth);
  });

  test('a move into a new group takes its name from the words you typed', async () => {
    const { h, ids } = await scene({ action: 'move', destination: 'new', name: 'Social', tabs: linkedin });
    const r = await h.send({ type: 'ask', text: 'put all the linkedin stuff in a new group Social' });
    expect(r.done).toMatchObject({ moved: 2, name: 'Social', isNew: true });
    expect(groupOf(h, ids.li1)).toBe('Social');
    expect(groupOf(h, ids.li2)).toBe('Social');
  });

  test('a described move: sure tabs move, close calls become a question, then the check screen', async () => {
    const tabs = (line) => (/funnel|signups/i.test(line) ? 0.92 : /referrals/i.test(line) ? 0.5 : 0.04);
    const { h, ids, g } = await scene({ action: 'move', destination: 'Growth', tabs });
    const r = await h.send({ type: 'ask', text: 'Move the dashboards and funnel reports into Growth' });
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0].samples).toEqual(['Partner referrals · Dashboards']);
    const a = await h.send({ type: 'askAnswer', session: r.session, answers: { [r.questions[0].id]: 'yes' } });
    expect(a.preview.tabs.map((t) => [t.id, t.section]).sort()).toEqual([[ids.f1, 'fit'], [ids.f2, 'fit'], [ids.r1, 'yes']].sort());
    const done = await h.send({ type: 'askApply', plan: a.preview.plan });
    expect(done.done).toMatchObject({ moved: 3, groupId: g.growth });
  });

  test('rename: the new name is copied from your words; a taken name offers a merge', async () => {
    const { h, g } = await scene({ action: 'rename', subject: 'Growth 2', name: 'paid growth' });
    const r = await h.send({ type: 'ask', text: 'growth 2 should really be paid growth' });
    expect(r.done.renamed).toEqual({ from: 'Growth 2', to: 'Paid growth' });
    expect(h.fake.allGroups().find((x) => x.id === g.growth2).title).toBe('Paid growth');
    await h.send({ type: 'askUndo' });

    const h2 = await scene({ action: 'rename', subject: 'Growth 2', name: 'hiring' });
    const c = await h2.h.send({ type: 'ask', text: 'rename growth 2 to hiring' });
    expect(c.questions[0].kind).toBe('clash');
    const m = await h2.h.send({ type: 'askAnswer', session: c.session, answers: { clash: 'merge' } });
    expect(m.done.message).toBe('Merged Growth 2 into Hiring. It now has 4 tabs.');
  });

  test('when Jev is unsure which group, it asks with the likeliest ones', async () => {
    const { h, g } = await scene({ action: 'ungroup', subject: 'Growth', conf: { subject: 0.45 }, probs: { subject: { 'Growth 2': 0.4 } } });
    const r = await h.send({ type: 'ask', text: 'ungroup the growth one' });
    expect(r.questions[0]).toMatchObject({ id: 'subject', kind: 'pick' });
    expect(r.questions[0].options.map((o) => o.value)).toEqual([String(g.growth), String(g.growth2)]);
    const a = await h.send({ type: 'askAnswer', session: r.session, answers: { subject: String(g.growth2) } });
    expect(a.done.ungrouped).toBe(2);
    expect(h.fake.allGroups().some((x) => x.id === g.growth2)).toBe(false);
  });

  test('when Jev is fairly but not fully sure, it confirms first', async () => {
    const { h, g } = await scene({ action: 'rename', subject: 'Hiring', name: 'Recruiting', conf: { name: 0.7 } });
    const r = await h.send({ type: 'ask', text: 'hiring → Recruiting' });
    expect(r.questions[0]).toMatchObject({ kind: 'confirm', text: 'Rename Hiring to Recruiting?' });
    const no = await h.send({ type: 'askAnswer', session: r.session, answers: { confirm: 'no' } });
    expect(no.reply).toMatch(/nothing changed/);
    const yes = await h.send({ type: 'askAnswer', session: r.session, answers: { confirm: 'yes' } });
    expect(yes.done.renamed.to).toBe('Recruiting');
    expect(h.fake.allGroups().find((x) => x.id === g.hiring).title).toBe('Recruiting');
  });

  test('an unclear action is asked about; "none" gets the help text', async () => {
    const { h } = await scene({ action: 'move', conf: { action: 0.4 }, actionProbs: { move: 0.4, merge: 0.35, none: 0.25 } });
    const r = await h.send({ type: 'ask', text: 'growth stuff together' });
    expect(r.questions[0].options.map((o) => o.value)).toEqual(['move', 'merge']);
    const s2 = await scene({ action: 'none' });
    expect((await s2.h.send({ type: 'ask', text: 'what time is it' })).reply).toMatch(/move tabs into groups/);
  });

  test('without a key, Ask says it needs one', async () => {
    const { h } = await scene({ action: 'move' }, { jevApiKey: '' });
    expect((await h.send({ type: 'ask', text: 'merge growth 2 into growth' })).reply).toMatch(/needs a Jev API key/);
  });

  test('tabs in other windows come along into the target window, and back on undo', async () => {
    const { h, ids, g } = await scene({ action: 'move', destination: 'Hiring', tabs: linkedin });
    const w = await h.chrome.windows.create({});
    const far = await h.fake.open('https://www.linkedin.com/in/another', { title: 'Another | LinkedIn', windowId: w.id });
    const r = await h.send({ type: 'ask', text: 'all linkedin into hiring' });
    expect(r.done.moved).toBe(2);
    expect(h.fake.tab(far).groupId).toBe(g.hiring);
    expect(h.fake.tab(far).windowId).toBe(h.fake.tab(ids.cand).windowId);
    await h.send({ type: 'askUndo' });
    expect(h.fake.tab(far).windowId).toBe(w.id);
  });
});
