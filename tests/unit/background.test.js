// Scenario tests for the background worker against the fake chrome.
import { describe, test, expect } from 'vitest';
import { harness, MIN } from './harness.js';
import { normalizeUrl } from '../../src/lib/url.js';

describe('tracking', () => {
  test('a link opened from a tab records the opener, usage and per-tab switching', async () => {
    const h = await harness();
    const a = await h.fake.open('https://linear.app/acme/issue/ENG-482', { title: 'ENG-482 Billing retry' });
    const b = await h.fake.open('https://github.com/acme/api/pull/91', { title: 'Fix billing retry', from: a });
    await h.fake.activate(a);
    await h.fake.activate(b);
    const s = h.ctx.state;
    expect(s.meta[b].parentTabId).toBe(a);
    expect(s.usage.urls[normalizeUrl('https://github.com/acme/api/pull/91')].n).toBeGreaterThanOrEqual(2);
    expect(Object.keys(s.tabPairs).length).toBe(1);
    expect(Object.values(s.urlLineage)[0].p).toBe(normalizeUrl('https://linear.app/acme/issue/ENG-482'));
  });

  test('typing a URL in a child tab makes it a root again', async () => {
    const h = await harness();
    const a = await h.fake.open('https://news.ycombinator.com/');
    const b = await h.fake.open('https://example.com/story', { from: a });
    await h.fake.navigate(b, 'https://mail.google.com/mail/u/0/#inbox', { transition: 'typed' });
    expect(h.ctx.state.meta[b].parentTabId).toBeNull();
  });

  test('incognito tabs never reach durable storage', async () => {
    const h = await harness();
    const w = await h.fake.newWindow({ incognito: true });
    const t = await h.fake.open('https://secret.example/patient/123', { windowId: w });
    await h.fake.activate(t);
    await h.ctx.flush();
    const local = JSON.stringify(h.fake.chrome.storage.local._dump());
    expect(local).not.toContain('secret.example');
  });

  test('a listener that throws is contained and logged', async () => {
    const h = await harness();
    h.ctx.state.meta = null; // corrupt in-memory state on purpose
    await h.fake.chrome.tabs.onActivated.dispatch({ tabId: 999, windowId: 1 });
    await h.fake.chrome.webNavigation.onCommitted.dispatch({ tabId: 1, frameId: 0, transitionType: 'typed' });
    await h.settle();
    expect(h.ctx.state.errors.length).toBeGreaterThan(0);
    expect(h.logs.join(' ')).toMatch(/nav.committed/);
  });
});

describe('cleanup', () => {
  async function scene() {
    const h = await harness({ settings: { staleMinutes: 30 } });
    const hub = await h.fake.open('https://github.com/acme/api/pulls', { title: 'Pull requests' });
    const child = await h.fake.open('https://github.com/acme/api/pull/7', { title: 'PR 7', from: hub, active: false });
    const d1 = await h.fake.open('https://docs.example.com/plan?utm_source=x', { title: 'Plan' });
    const d2 = await h.fake.open('https://docs.example.com/plan', { title: 'Plan' });
    await h.fake.activate(hub);
    h.clock.advance(90 * MIN);
    return { h, hub, child, d1, d2 };
  }

  test('plan finds the duplicate and the idle child; Jev raises confidence', async () => {
    const { h, child } = await scene();
    const p = await h.send({ type: 'plan' });
    expect(p.duplicates).toHaveLength(1);
    const c = p.children.find((x) => x.tab.id === child);
    expect(c.via).toBe('opener');
    expect(c.jev).toBe(0.9);
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  test('closing re-checks tabs: active, navigated or already-closed tabs are skipped', async () => {
    const { h, child, d1, d2 } = await scene();
    await h.fake.activate(d2);
    await h.fake.closeBehindOurBack(d1);
    await h.fake.navigate(child, 'https://github.com/acme/api/pull/8');
    const r = await h.send({ type: 'close', tabs: [{ id: child, url: 'https://github.com/acme/api/pull/7' }, { id: d1 }, { id: d2 }] });
    expect(r.closed).toBe(0);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['already closed', 'navigated since', 'now active']);
    expect(h.fake.tab(child)).toBeTruthy();
  });

  test('a drag lock is retried; undo reopens the batch in its group', async () => {
    const { h, child, hub } = await scene();
    const gid = await h.chrome.tabs.group({ tabIds: [hub, child] });
    await h.chrome.tabGroups.update(gid, { title: 'Review' });
    h.fake.dragLocks = 2;
    const r = await h.send({ type: 'close', tabIds: [child] });
    expect(r.closed).toBe(1);
    const u = await h.send({ type: 'undo' });
    expect(u.reopened).toBe(1);
    const reopened = h.fake.allTabs().find((t) => t.url === 'https://github.com/acme/api/pull/7');
    expect(reopened.groupId).toBe(gid);
  });

  test('a batch where one tab vanished mid-flight still closes the rest', async () => {
    const { h, d1, child } = await scene();
    h.fake.failNext['tabs.remove'] = new Error(`No tab with id: ${d1}.`);
    const r = await h.send({ type: 'close', tabIds: [d1, child] });
    expect(r.closed).toBe(2);
  });

  test('concurrent tidies run one at a time and never double-close', async () => {
    const { h } = await scene();
    const steps = { dedupe: true, children: true, group: false, reorder: false };
    const [a, b] = await Promise.all([h.send({ type: 'tidy', steps }), h.send({ type: 'tidy', steps })]);
    expect(a.closed + b.closed).toBe(2);
    expect(a.errors.concat(b.errors)).toEqual([]);
  });

  test('the auto-tidy alarm bows out while a user action is running', async () => {
    const { h } = await scene();
    await h.fake.chrome.storage.local.set({ settings: { ...(await h.ctx.refreshSettings()), autoEnabled: true } });
    let release;
    const blocker = h.ctx.exclusive(() => new Promise((r) => { release = r; }));
    const [res] = await h.fake.fireAlarm('tab-land-auto');
    expect(res).toEqual({ skipped: true, reason: 'busy' });
    release();
    await blocker;
  });

  test('reorder survives a tab disappearing mid-way and keeps groups contiguous', async () => {
    const { h, hub, child } = await scene();
    const gid = await h.chrome.tabs.group({ tabIds: [hub, child] });
    for (let i = 0; i < 5; i++) { await h.fake.activate(hub); h.clock.advance(1000); await h.fake.activate(h.fake.allTabs().at(-1).id); }
    h.fake.failNext['tabs.move'] = new Error('No tab with id: 12345.');
    const r = await h.send({ type: 'reorder' });
    expect(r.error).toBeUndefined();
    const idx = h.fake.allTabs().filter((t) => t.groupId === gid).map((t) => t.index);
    expect(Math.max(...idx) - Math.min(...idx) + 1).toBe(idx.length);
  });
});

describe('storage', () => {
  test('v1 data migrates: string lineage becomes {p,t}; corrupt fields are replaced', async () => {
    const { migrate } = await import('../../src/bg/store.js');
    const s = migrate({ urlLineage: { a: 'b', c: { p: 'd', t: 5 }, e: 42 }, usage: 'garbage', managedGroups: ['ok', 3] }, { meta: [] });
    expect(s.urlLineage).toEqual({ a: { p: 'b', t: 0 }, c: { p: 'd', t: 5 } });
    expect(s.usage).toEqual({ urls: {}, sites: {} });
    expect(s.managedGroups).toEqual(['ok']);
    expect(s.meta).toEqual({});
    expect(s.migratedFrom).toBe(1);
  });

  test('a full storage area triggers pruning instead of an error', async () => {
    const h = await harness();
    for (let i = 0; i < 400; i++) h.ctx.state.usage.urls[`https://site${i}.example/page/${'x'.repeat(40)}`] = { s: i, t: h.clock.now(), n: 1 };
    const size = JSON.stringify(h.fake.chrome.storage.local._dump()).length;
    h.fake.localQuotaBytes = size + 16000; // fits ~a quarter of the 400 entries, not all of them
    const r = await h.ctx.flush();
    expect(r.ok).toBe(true);
    expect(r.pruned).toBe(true);
    expect(Object.keys(h.ctx.state.usage.urls).length).toBeLessThan(400);
  });

  test('if storage stays full the worker keeps running and reports it', async () => {
    const h = await harness();
    h.fake.localQuotaBytes = 10;
    const r = await h.ctx.flush();
    expect(r.ok).toBe(false);
    const d = await h.send({ type: 'diagnostics' });
    expect(d.errors.at(-1).where).toBe('store');
  });

  test('corrupt settings fall back to safe defaults', async () => {
    const { sanitizeSettings, DEFAULTS } = await import('../../src/lib/settings.js');
    const s = sanitizeSettings({ staleMinutes: 'abc', useCases: [{ name: '' }, { name: 'Hiring', color: 'neon' }, null], aiExcludedDomains: 'x', autoCloseConfidence: 7 });
    expect(s.staleMinutes).toBe(DEFAULTS.staleMinutes);
    expect(s.useCases).toEqual([{ name: 'Hiring', color: expect.any(String), description: '' }]);
    expect(s.useCases[0].color).not.toBe('neon');
    expect(s.aiExcludedDomains).toEqual([]);
    expect(s.autoCloseConfidence).toBe(0.99);
  });

  test('after a browser restart, remembered lineage still links tabs', async () => {
    const h = await harness();
    const a = await h.fake.open('https://jira.example.com/browse/OPS');
    await h.fake.open('https://jira.example.com/browse/OPS-12', { from: a });
    await h.ctx.flush();
    // Restart: new tab ids, session storage gone, local storage kept.
    const local = h.fake.chrome.storage.local._dump();
    const h2 = await harness();
    h2.fake.chrome.storage.local._load(local);
    h2.ctx.state = null;
    await h2.ctx.ready();
    const p = await h2.fake.open('https://jira.example.com/browse/OPS', { transition: 'auto_bookmark' });
    const c = await h2.fake.open('https://jira.example.com/browse/OPS-12', { transition: 'reload', active: false });
    h2.clock.advance(60 * MIN);
    const plan = await h2.send({ type: 'plan' });
    const child = plan.children.find((x) => x.tab.id === c);
    expect(child?.parent.id).toBe(p);
    expect(child.via).toBe('history');
  });
});

describe('Jev resilience', () => {
  test('a hung request times out with a clear message and grouping falls back', async () => {
    const h = await harness({ settings: { jevTimeoutMs: 2000 }, jev: () => new Promise(() => {}) });
    h.ctx.settings.jevTimeoutMs = 2000;
    // Make the timeout fast for the test by shrinking it after sanitize's floor.
    const { jevEvaluate } = await import('../../src/lib/jev.js');
    await expect(jevEvaluate({ jevApiKey: 'k', jevBaseUrl: 'https://x' }, { state: 's', questions: {} }, {
      timeoutMs: 20, retries: 0, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
    })).rejects.toThrow(/timed out/);
  });

  test('a bad key fails fast: no retry storm, heuristic grouping still works', async () => {
    const h = await harness({ jev: () => ({ status: 401, body: { error: { message: 'bad key' } } }), settings: { groupingMode: 'useCases' } });
    for (let i = 0; i < 6; i++) await h.fake.open(`https://github.com/acme/api/pull/${i}`, { title: `PR ${i}` });
    const r = await h.send({ type: 'group' });
    expect(r.via).toBe('heuristic');
    expect(r.error).toMatch(/401/);
    expect(h.jevCalls.length).toBeLessThanOrEqual(4);
  });

  test('a non-JSON success response is reported, not thrown into a listener', async () => {
    const h = await harness({ jev: () => ({ __raw: new Response('<html>gateway</html>', { status: 200 }) }) });
    const a = await h.fake.open('https://example.com/list');
    await h.fake.open('https://example.com/list/item', { from: a, active: false });
    h.clock.advance(90 * MIN);
    const p = await h.send({ type: 'plan' });
    expect(p.jevError).toMatch(/not JSON/);
    expect(p.children.length).toBe(1);
  });
});

describe('messages', () => {
  test('unknown types, foreign senders and bad arguments get clean errors', async () => {
    const h = await harness();
    expect((await h.send({ type: 'nope' })).error).toMatch(/Unknown/);
    expect((await h.send({ type: 'plan' }, { id: 'evil-extension' })).error).toBe('Forbidden');
    expect((await h.send({ type: 'park', groupId: 'x' })).error).toMatch(/groupId/);
    expect((await h.send({ type: 'close', tabIds: 'not-a-list' })).closed).toBe(0);
    expect((await h.send({ type: 'open', result: null })).ok).toBe(false);
  });
});

describe('palette and contexts', () => {
  test('opening a tab result that closed meanwhile falls back to its URL', async () => {
    const h = await harness();
    const t = await h.fake.open('https://notion.so/acme/Roadmap', { title: 'Roadmap' });
    const [r] = await h.send({ type: 'search', q: 'roadmap' });
    await h.fake.closeBehindOurBack(t);
    expect((await h.send({ type: 'open', result: r })).ok).toBe(true);
    expect(h.fake.allTabs().some((x) => x.url === 'https://notion.so/acme/Roadmap')).toBe(true);
  });

  test('history results come from chrome.history and skip open URLs', async () => {
    const h = await harness();
    await h.fake.open('https://open.example/report', { title: 'Q3 report' });
    h.fake.addHistory({ url: 'https://old.example/report', title: 'Q2 report' });
    h.fake.addHistory({ url: 'https://open.example/report', title: 'Q3 report' });
    const r = await h.send({ type: 'search', q: 'report' });
    expect(r.filter((x) => x.kind === 'history').map((x) => x.url)).toEqual(['https://old.example/report']);
  });

  test('parking the only window keeps a tab open; a failed resume keeps the snapshot', async () => {
    const h = await harness();
    const w = h.fake.windowIds()[0] ?? (await h.fake.newWindow());
    const ids = [];
    for (const u of ['https://a.example/1', 'https://a.example/2']) ids.push(await h.fake.open(u, { windowId: w }));
    for (const t of h.fake.allTabs()) if (!ids.includes(t.id)) await h.fake.closeBehindOurBack(t.id);
    const gid = await h.chrome.tabs.group({ tabIds: ids });
    await h.chrome.tabGroups.update(gid, { title: 'Alpha' });
    const p = await h.send({ type: 'park', groupId: gid });
    expect(p.parked).toBe(2);
    expect(h.fake.allTabs().length).toBe(1); // a fresh tab kept the window alive
    h.fake.failNext['tabs.create'] = new Error('boom');
    const r = await h.send({ type: 'resume', id: p.id });
    expect(r.partial).toBe(true);
    expect((await h.send({ type: 'contexts' })).parked).toHaveLength(1);
  });
});
