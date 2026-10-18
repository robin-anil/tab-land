// More background scenarios: learning, wiring (alarms/commands/install), focus, palette fallbacks.
import { describe, test, expect } from 'vitest';
import { harness, MIN } from './harness.js';

describe('learning', () => {
  test('evidence from grouping becomes site updates; co-used uncovered sites become a named use case', async () => {
    const jev = (body) => {
      const answers = {};
      for (const [q, spec] of Object.entries(body.questions)) {
        if (q === 'name') { const k = Object.keys(spec.criteria).find((x) => spec.criteria[x].startsWith('Fundraising:')); answers[q] = { type: 'choice', choice: k, confidence: 0.8 }; }
        else if (spec.type === 'choice') { const k = Object.keys(spec.criteria).find((x) => spec.criteria[x].startsWith('Hiring:')); answers[q] = { type: 'choice', choice: k, confidence: 0.9 }; }
        else answers[q] = { type: 'noul', noul: 0.5 };
      }
      return { answers };
    };
    const h = await harness({ jev, settings: { groupingMode: 'useCases' } });
    const ats = await h.fake.open('https://app.ashbyhq.com/candidates', { title: 'Candidates' });
    await h.fake.open('https://www.linkedin.com/in/jane', { title: 'Jane Doe', from: ats });
    await h.send({ type: 'group' });
    const carta = await h.fake.open('https://carta.com/cap-table', { title: 'Cap table' });
    const ds = await h.fake.open('https://docsend.com/room', { title: 'Data room' });
    for (let i = 0; i < 6; i++) { await h.fake.activate(carta); h.clock.advance(MIN); await h.fake.activate(ds); h.clock.advance(MIN); }
    const s = await h.send({ type: 'learn' });
    expect(s.enrich.find((e) => e.name === 'Hiring')?.sites).toEqual(expect.arrayContaining(['app.ashbyhq.com']));
    const add = s.add.find((a) => a.sites.includes('carta.com'));
    expect(add).toMatchObject({ name: 'Fundraising', via: 'jev' });
    const applied = await h.send({ type: 'applyLearn', changes: { add: [add], enrich: s.enrich, retire: ['Personal'] } });
    expect(applied.useCases.map((u) => u.name)).toEqual(expect.arrayContaining(['Fundraising', 'Hiring']));
    expect(applied.useCases.some((u) => u.name === 'Personal')).toBe(false);
    expect((await h.send({ type: 'useCaseUsage' })).Hiring.n).toBeGreaterThan(0);
  });

  test('auto-tune only refreshes sites, and can be turned off', async () => {
    const h = await harness();
    h.ctx.state.useCaseStats = { Hiring: { n: 3, t: h.clock.now(), sites: { 'ashby.com': 3 } } };
    const r = await h.fake.fireAlarm('tab-land-learn');
    expect(r[0]).toEqual({ enriched: 1 });
    const s = await h.ctx.refreshSettings();
    expect(s.useCases.find((u) => u.name === 'Hiring').sites).toEqual(['ashby.com']);
    await h.chrome.storage.local.set({ settings: { ...s, autoTuneUseCases: false } });
    expect((await h.fake.fireAlarm('tab-land-learn'))[0]).toEqual({ skipped: true });
  });

  test('learning without a key names clusters from their sites; excluded domains never appear', async () => {
    const h = await harness({ settings: { jevApiKey: '', aiExcludedDomains: ['ehr.example'] } });
    const a = await h.fake.open('https://ehr.example/chart');
    const b = await h.fake.open('https://billing.example/claims');
    const c = await h.fake.open('https://payer.example/eligibility');
    for (let i = 0; i < 6; i++) { for (const id of [a, b, c]) { await h.fake.activate(id); h.clock.advance(MIN); } }
    const s = await h.send({ type: 'learn' });
    expect(JSON.stringify(s.add)).not.toContain('ehr.example');
    expect(s.add[0]).toMatchObject({ via: 'sites' });
  });
});

describe('wiring', () => {
  test('install opens settings and schedules the learning alarm; auto alarm follows settings', async () => {
    const h = await harness();
    await h.chrome.runtime.onInstalled.dispatch({ reason: 'install' });
    expect(h.fake.calls).toContain('runtime.openOptionsPage');
    expect(await h.chrome.alarms.get('tab-land-learn')).toBeTruthy();
    expect(await h.chrome.alarms.get('tab-land-auto')).toBeUndefined();
    await h.chrome.storage.local.set({ settings: { ...(await h.ctx.refreshSettings()), autoEnabled: true, autoIntervalMin: 2 } });
    await h.settle();
    expect((await h.chrome.alarms.get('tab-land-auto')).periodInMinutes).toBe(5); // floor
  });

  test('the tidy shortcut runs every step', async () => {
    const h = await harness();
    await h.fake.open('https://dup.example/a');
    await h.fake.open('https://dup.example/a');
    const [r] = await h.chrome.commands.onCommand.dispatch('tidy-now');
    expect(r.closed).toBe(1);
  });

  test('startup and suspend: state loads, pending writes flush', async () => {
    const h = await harness();
    await h.chrome.runtime.onStartup.dispatch();
    await h.fake.open('https://x.example/');
    await h.chrome.runtime.onSuspend.dispatch();
    expect(JSON.stringify(h.fake.chrome.storage.local._dump().usage)).toContain('x.example');
  });

  test('test key, diagnostics, reset and focus messages', async () => {
    const h = await harness();
    expect(await h.send({ type: 'testKey', settings: { jevApiKey: 'k' } })).toEqual({ ok: true, models: ['jev-latest'] });
    const t = await h.fake.open('https://a.example/');
    await h.fake.open('https://b.example/');
    expect(await h.send({ type: 'focus', tabId: t, windowId: h.fake.tab(t).windowId })).toEqual({ ok: true });
    expect(h.fake.tab(t).active).toBe(true);
    expect((await h.send({ type: 'focus' })).error).toBeTruthy();
    const d = await h.send({ type: 'diagnostics' });
    expect(d.sizes.urls).toBeGreaterThan(0);
    await h.send({ type: 'resetLearned' });
    expect((await h.send({ type: 'diagnostics' })).sizes.urls).toBe(0);
  });
});

describe('tracking edges', () => {
  test('window blur credits dwell and clears the active tab; replaced tabs keep their history', async () => {
    const h = await harness();
    const a = await h.fake.open('https://dwell.example/');
    h.clock.advance(20 * MIN);
    await h.fake.blurAll();
    expect(h.ctx.state.lastActive).toBeNull();
    const u = Object.values(h.ctx.state.usage.urls)[0];
    expect(u.s).toBeGreaterThan(1.5);
    await h.chrome.tabs.onReplaced.dispatch(500, a);
    expect(h.ctx.state.meta[500]).toBeTruthy();
    expect(h.ctx.state.meta[a]).toBeUndefined();
  });

  test('closing a parent hands its children to the grandparent', async () => {
    const h = await harness();
    const g = await h.fake.open('https://g.example/');
    const p = await h.fake.open('https://g.example/p', { from: g });
    const c = await h.fake.open('https://g.example/p/c', { from: p });
    await h.chrome.tabs.remove(p);
    expect(h.ctx.state.meta[c].parentTabId).toBe(g);
  });
});

describe('palette fallbacks', () => {
  test('a recently closed result restores the session; a stale session falls back to the URL', async () => {
    const h = await harness();
    const t = await h.fake.open('https://closed.example/board', { title: 'Sprint board' });
    await h.fake.open('https://keep.example/');
    await h.chrome.tabs.remove(t);
    const [hit] = (await h.send({ type: 'search', q: 'sprint' })).filter((r) => r.kind === 'closed');
    expect(hit).toBeTruthy();
    expect((await h.send({ type: 'open', result: { ...hit, sessionId: 'stale' } })).ok).toBe(true);
    expect(h.fake.allTabs().some((x) => x.url === 'https://closed.example/board')).toBe(true);
  });

  test('a history result switches to the tab if it is already open', async () => {
    const h = await harness();
    const t = await h.fake.open('https://hist.example/doc');
    await h.fake.open('https://other.example/');
    await h.send({ type: 'open', result: { kind: 'history', url: 'https://hist.example/doc' } });
    expect(h.fake.tab(t).active).toBe(true);
    expect(h.fake.allTabs().filter((x) => x.url === 'https://hist.example/doc')).toHaveLength(1);
  });
});

describe('grouping applies safely', () => {
  test('a tab closed between planning and applying is skipped; groups are reused by title', async () => {
    let victim;
    const jev = async (body) => {
      if (victim) { const v = victim; victim = null; await h.fake.closeBehindOurBack(v); }
      const answers = {};
      for (const [q, spec] of Object.entries(body.questions)) {
        const k = Object.keys(spec.criteria).find((x) => spec.criteria[x].startsWith('Engineering:'));
        answers[q] = { type: 'choice', choice: k, confidence: 0.9 };
      }
      return { answers };
    };
    const h = await harness({ jev, settings: { groupingMode: 'useCases' } });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await h.fake.open(`https://github.com/acme/api/pull/${i}`, { title: `PR ${i}` }));
    victim = ids[0];
    const r = await h.send({ type: 'group' });
    expect(r.groups[0]).toMatchObject({ name: 'Engineering' });
    expect(h.fake.allGroups()).toHaveLength(1);
    await h.fake.open('https://github.com/acme/api/pull/9', { title: 'PR 9' });
    await h.send({ type: 'group' });
    expect(h.fake.allGroups()).toHaveLength(1);
    expect(h.fake.allTabs().filter((t) => t.groupId === h.fake.allGroups()[0].id)).toHaveLength(4);
  });
});

describe('Jev naming requests', () => {
  test('existing names are not offered; titles respect the privacy toggle', async () => {
    const { buildNamingRequests, parseNamingResponses } = await import('../../src/lib/jev.js');
    const { DEFAULTS } = await import('../../src/lib/settings.js');
    const reqs = buildNamingRequests([{ sites: ['carta.com', 'docsend.com'], titles: ['Cap table – Acme'] }], { settings: { ...DEFAULTS, sendTitles: false }, exclude: ['Hiring'] });
    const crit = reqs[0].body.questions.name.criteria;
    expect(Object.values(crit).some((d) => d.startsWith('Hiring:'))).toBe(false);
    expect(reqs[0].body.state).not.toContain('Cap table');
    const key = Object.keys(crit).find((k) => crit[k].startsWith('Fundraising:'));
    expect(parseNamingResponses(reqs, [{ answers: { name: { choice: key, confidence: 0.7 } } }])[0]).toEqual({ name: 'Fundraising', confidence: 0.7 });
    expect(parseNamingResponses(reqs, [{ answers: { name: { choice: 'bogus' } } }])[0]).toBeNull();
  });
});
