// Versions of the same page under the master/detail model.
import { describe, test, expect } from 'vitest';
import { pageKey, normalizeUrl } from '../../src/lib/url.js';
import { findPageVariants } from '../../src/lib/dedupe.js';
import { harness, MIN } from './harness.js';

describe('pageKey: what page is this a version of?', () => {
  test.each([
    ['https://docs.example.com/guide#install', 'https://docs.example.com/guide'],
    ['https://docs.example.com/guide#:~:text=hello', 'https://docs.example.com/guide'],
    ['https://app.example.com/report?view=table&sort=desc', 'https://app.example.com/report'],
    ['https://github.com/acme/api/issues?q=is%3Aopen+label%3Abug', 'https://github.com/acme/api/issues'],
    ['https://www.youtube.com/watch?v=abc&t=42s&si=xyz', 'https://youtube.com/watch?v=abc'],
    ['https://www.google.com/search?q=tab+manager&sourceid=chrome&ie=UTF-8', 'https://google.com/search?q=tab+manager'],
    ['https://shop.example.com/item.php?id=12&color=red', 'https://shop.example.com/item.php?id=12'],
    ['https://mail.google.com/mail/u/0/#inbox/FMfcg123?compose=new', 'https://mail.google.com/mail/u/0#inbox/FMfcg123'],
    ['https://app.example.com/#/settings/billing?tab=2', 'https://app.example.com/#/settings/billing'],
  ])('%s → %s', (url, key) => expect(pageKey(url)).toBe(key));

  test('different content stays different', () => {
    expect(pageKey('https://youtube.com/watch?v=a')).not.toBe(pageKey('https://youtube.com/watch?v=b'));
    expect(pageKey('https://shop.example.com/item.php?id=12')).not.toBe(pageKey('https://shop.example.com/item.php?id=13'));
    expect(pageKey('https://mail.google.com/mail/u/0/#inbox/A')).not.toBe(pageKey('https://mail.google.com/mail/u/0/#inbox/B'));
    expect(pageKey('https://example.com/a')).not.toBe(pageKey('https://example.com/b'));
  });
});

describe('findPageVariants', () => {
  const now = Date.UTC(2026, 9, 18, 16);
  let id = 1;
  const T = (url, o = {}) => ({ id: id++, url, title: url, windowId: 1, index: id, lastAccessed: now - 60 * MIN, openedAt: now - 60 * MIN, ...o });

  test('keeps the version in use; idle versions are details of it', () => {
    const master = T('https://app.example.com/report?view=table', { lastAccessed: now - 1 * MIN });
    const a = T('https://app.example.com/report?view=chart');
    const b = T('https://app.example.com/report#totals');
    const fresh = T('https://app.example.com/report?sort=desc', { lastAccessed: now - 2 * MIN });
    const other = T('https://app.example.com/other');
    const r = findPageVariants([master, a, b, fresh, other], { now, idleMinutes: 10 });
    expect(r.map((x) => x.tab.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.every((x) => x.parent.id === master.id && x.signals.via === 'variant')).toBe(true);
  });

  test('never closes active, pinned, audible or protected versions; exact copies are left to dedupe', () => {
    const m = T('https://x.example/p', { lastAccessed: now });
    const act = T('https://x.example/p?a=1', { active: true, windowId: 2 });
    const pin = T('https://x.example/p?a=2', { pinned: true });
    const aud = T('https://x.example/p?a=3', { audible: true });
    const prot = T('https://x.example/p?a=4');
    expect(findPageVariants([m, act, pin, aud, prot], { now, isProtected: (t) => t.id === prot.id })).toEqual([]);
    expect(findPageVariants([T('https://y.example/q'), T('https://y.example/q')], { now })).toEqual([]);
  });

  test('the plain page wins a tie on recency', () => {
    const plain = T('https://z.example/doc');
    const detail = T('https://z.example/doc?mode=edit');
    const [r] = findPageVariants([detail, plain], { now });
    expect(r.parent.id).toBe(plain.id);
  });
});

describe('closing versions (background)', () => {
  async function scene(settings = {}) {
    const h = await harness({ settings: { jevApiKey: '', ...settings } });
    const master = await h.fake.open('https://app.example.com/report?view=table', { title: 'Report' });
    const v1 = await h.fake.open('https://app.example.com/report?view=chart', { title: 'Report', active: false });
    const v2 = await h.fake.open('https://app.example.com/report#totals', { title: 'Report', active: false });
    const dup = await h.fake.open('https://app.example.com/report?view=table', { title: 'Report', active: false });
    h.clock.advance(15 * MIN);
    await h.fake.activate(master);
    return { h, master, v1, v2, dup };
  }

  test('versions show up as details of the master, pre-selected', async () => {
    const { h, master, v1, v2 } = await scene();
    const p = await h.send({ type: 'plan' });
    const details = p.children.filter((c) => c.via === 'variant');
    expect(details.map((c) => c.tab.id).sort()).toEqual([v1, v2].sort());
    expect(details.every((c) => c.parent.id === master && c.confidence >= p.autoCloseConfidence)).toBe(true);
  });

  test('the background sweep closes unused copies and versions, keeps the master, and undo restores them', async () => {
    const { h, master, v1, v2, dup } = await scene();
    const r = await h.send({ type: 'sweep' });
    expect(r.closed).toBe(3);
    expect(h.fake.tab(master)).toBeTruthy();
    for (const id of [v1, v2, dup]) expect(h.fake.tab(id)).toBeUndefined();
    await h.send({ type: 'undo' });
    expect(h.fake.allTabs().filter((t) => t.url.startsWith('https://app.example.com/report')).length).toBe(4);
  });

  test('a version you used recently is kept; the sweep also runs on its alarm', async () => {
    const { h, v1 } = await scene();
    await h.fake.activate(v1);
    h.clock.advance(1 * MIN);
    await h.fake.activate(h.fake.allTabs()[0].id);
    const [r] = await h.fake.fireAlarm('tab-land-sweep');
    expect(r.closed).toBeGreaterThan(0);
    expect(h.fake.tab(v1)).toBeTruthy();
  });

  test('opening a page sweeps older unused versions of it right away', async () => {
    const { h, v1 } = await scene();
    h.ctx.sweepDelayMs = 0;
    await h.ctx.refreshSettings();
    const fresh = await h.fake.open('https://app.example.com/report?view=chart&x=1', { title: 'Report' });
    await h.chrome.tabs.onUpdated.dispatch(fresh, { status: 'complete' }, h.fake.tab(fresh));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.fake.tab(v1)).toBeUndefined();
    expect(h.fake.tab(fresh)).toBeTruthy();
  });

  test('turning the settings off stops it', async () => {
    const { h, v1 } = await scene({ autoCloseDuplicates: false, closeVariants: false });
    expect((await h.send({ type: 'sweep' })).skipped).toBe(true);
    const p = await h.send({ type: 'plan' });
    expect(p.children.some((c) => c.via === 'variant')).toBe(false);
    expect(h.fake.tab(v1)).toBeTruthy();
    expect(await h.chrome.alarms.get('tab-land-sweep')).toBeUndefined();
  });

  test('exact copies still count as duplicates, ignoring #section jumps', async () => {
    const h = await harness({ settings: { jevApiKey: '' } });
    await h.fake.open('https://docs.example.com/guide#install');
    await h.fake.open('https://docs.example.com/guide#usage');
    const p = await h.send({ type: 'plan' });
    expect(p.duplicates).toHaveLength(1);
    expect(normalizeUrl('https://docs.example.com/guide#install')).toBe(normalizeUrl('https://docs.example.com/guide'));
  });
});
