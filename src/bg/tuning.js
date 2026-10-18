// "Export tabs for tuning": a snapshot of what grouping sees, saved to a file on the user's computer
// so scripts/tune.mjs can tune thresholds against real tabs with real Jev answers.
// Incognito tabs are left out. The API key is never included.
import { normalizeUrl, isWebUrl } from '../lib/url.js';
import { snapshot, groupTitleMap } from './context.js';

export async function exportTuning(ctx) {
  await ctx.ready();
  const s = await ctx.refreshSettings();
  const own = ctx.ownPrefix();
  const tabs = (await snapshot(ctx)).filter((t) => !t.incognito && isWebUrl(t.url) && !t.url.startsWith(own));
  const titles = await groupTitleMap(ctx);
  const keys = new Set(tabs.map((t) => normalizeUrl(t.url)));
  const tabPairs = {};
  for (const [k, v] of Object.entries(ctx.state.tabPairs)) {
    const [a, b] = k.split('\u0001');
    if (keys.has(a) && keys.has(b)) tabPairs[k] = v;
  }
  const urlLineage = {};
  for (const [k, v] of Object.entries(ctx.state.urlLineage)) if (keys.has(k)) urlLineage[k] = v;
  return {
    kind: 'tab-land-tuning', version: 1, exportedAt: ctx.now(),
    settings: {
      groupingMode: s.groupingMode, goalThreshold: s.goalThreshold, minChoiceConfidence: s.minChoiceConfidence,
      halfLifeDays: s.halfLifeDays, sendTitles: s.sendTitles, sendPaths: s.sendPaths,
      aiExcludedDomains: s.aiExcludedDomains, jevModel: s.jevModel, jevBaseUrl: s.jevBaseUrl,
    },
    useCases: s.useCases,
    tabs: tabs.map((t) => ({
      id: t.id, url: t.url, title: t.title, windowId: t.windowId, index: t.index, pinned: t.pinned,
      groupId: t.groupId, groupTitle: t.groupId >= 0 ? titles.get(t.groupId) || '' : null,
      openedAt: t.openedAt, lastAccessed: t.lastAccessed, lastActivated: t.lastActivated,
      activations: t.activations, parentTabId: t.parentTabId, startTransition: t.startTransition,
    })),
    tabPairs, urlLineage,
  };
}
