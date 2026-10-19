// "Recently used last": on the tidy cycle, groups go oldest to newest (the one used last at the end),
// and so do the tabs inside each group. Nothing moves the moment you switch tabs.
import { describe, test, expect } from 'vitest';
import { harness, MIN } from './harness.js';
import { planWindowOrder } from '../../src/lib/reorder.js';
import { ORDER_ALARM } from '../../src/bg/app.js';

test('planWindowOrder "recent": oldest first, for groups and for the tabs inside them', () => {
  const tabs = [
    { id: 1, index: 0, pinned: true, groupId: -1, lastAccessed: 1 },
    { id: 2, index: 1, groupId: 10, lastAccessed: 900 },
    { id: 3, index: 2, groupId: 10, lastAccessed: 100 },
    { id: 4, index: 3, groupId: 20, lastAccessed: 300 },
    { id: 5, index: 4, groupId: -1, lastAccessed: 500 },
  ];
  const plan = planWindowOrder(tabs, () => 0, { order: 'recent' });
  expect(plan.startIndex).toBe(1);
  expect(plan.units).toEqual([
    { type: 'group', groupId: 20, tabIds: [4] },
    { type: 'tab', tabId: 5 },
    { type: 'group', groupId: 10, tabIds: [3, 2] },
  ]);
});

describe('on the fake Chrome', () => {
  async function scene(settings = {}) {
    const h = await harness({ settings: { jevApiKey: '', ...settings } });
    const a1 = await h.fake.open('https://a.example.com/1', { title: 'A1' });
    const a2 = await h.fake.open('https://a.example.com/2', { title: 'A2' });
    const b1 = await h.fake.open('https://b.example.com/1', { title: 'B1' });
    const c1 = await h.fake.open('https://c.example.com/1', { title: 'C1' });
    const mk = async (tabIds, title) => { const gid = await h.chrome.tabs.group({ tabIds }); await h.chrome.tabGroups.update(gid, { title }); return gid; };
    await mk([a1, a2], 'A'); await mk([b1], 'B'); await mk([c1], 'C');
    await h.settle();
    return { h, ids: { a1, a2, b1, c1 } };
  }
  const groupOrder = (h) => {
    const seen = [];
    for (const t of h.fake.allTabs().sort((x, y) => x.index - y.index)) {
      const title = h.fake.allGroups().find((x) => x.id === t.groupId)?.title;
      if (title && seen.at(-1) !== title) seen.push(title);
    }
    return seen;
  };
  const tabOrder = (h, ids) => ids.sort((x, y) => h.fake.tab(x).index - h.fake.tab(y).index);
  async function use(h, ...ids) { for (const id of ids) { h.clock.advance(5 * MIN); await h.fake.activate(id); } await h.settle(); }

  test('switching tabs moves nothing; the 20-minute cycle puts groups and their tabs oldest to newest', async () => {
    const { h, ids } = await scene();
    await use(h, ids.c1, ids.a2, ids.a1, ids.b1);
    expect(groupOrder(h)).toEqual(['A', 'B', 'C']); // untouched while reading
    await h.app.onAlarm({ name: ORDER_ALARM });
    expect(groupOrder(h)).toEqual(['C', 'A', 'B']);
    expect(tabOrder(h, [ids.a1, ids.a2])).toEqual([ids.a2, ids.a1]); // a1 used last → end of its group
  });

  test('the cycle runs on the Automatic tidy interval, and only when it is on', async () => {
    const { h } = await scene({ autoIntervalMin: 20 });
    await h.app.syncAlarms();
    expect((await h.chrome.alarms.get(ORDER_ALARM))?.periodInMinutes).toBe(20);
    await h.chrome.storage.local.set({ settings: { ...(await h.chrome.storage.local.get('settings')).settings, autoOrderGroups: false } });
    await h.app.syncAlarms();
    expect(await h.chrome.alarms.get(ORDER_ALARM)).toBeFalsy();
  });

  test('"Most used first" is still there from the Reorder button (ordering covered in logic tests)', async () => {
    const { h } = await scene({ groupOrder: 'usage' });
    expect((await h.send({ type: 'reorder' })).order).toBe('usage');
  });
});
