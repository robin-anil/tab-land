// Wires the modules to Chrome events and messages. createApp() is pure wiring: tests call it with a fake chrome.
import { jevModels } from '../lib/jev.js';
import { loadSettings } from '../lib/settings.js';
import { createContext } from './context.js';
import { tracking } from './tracking.js';
import { publicPlan, closeTabs, undoLast, reorderAll, tidy, sweepDuplicates } from './cleanup.js';
import { groupTabs, regroupAll, undoRegroup } from './grouping.js';
import { search, openResult, focusTab } from './palette.js';
import { listContexts, parkGroup, resumeContext, dropContext } from './contexts.js';
import { learnSuggestions, applyLearn, autoTune, useCaseUsage } from './learning.js';
import { guard } from './util.js';
import { exportTuning } from './tuning.js';

export const ALARM = 'tab-land-auto';
export const LEARN_ALARM = 'tab-land-learn';
export const SWEEP_ALARM = 'tab-land-sweep';

const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

export function createApp(deps) {
  const ctx = createContext(deps);
  const { chrome } = ctx;
  const track = tracking(ctx);
  const deps2 = { groupTabs };
  const mutate = (fn) => ctx.exclusive(fn);
  // Right after a page loads, look for older unused copies of it (debounced; skips while busy).
  let sweepTimer = null;
  ctx.onPageLoaded = () => {
    if (!ctx.settings?.autoCloseDuplicates) return;
    ctx.timers.clearTimeout(sweepTimer);
    sweepTimer = ctx.timers.setTimeout(() => {
      ctx.exclusive(() => sweepDuplicates(ctx), { skipIfBusy: true }).catch((e) => ctx.log(e, 'sweep'));
    }, ctx.sweepDelayMs ?? 3000);
  };

  /** Every message the UI can send. Mutating actions run one at a time. */
  const routes = {
    plan: () => publicPlan(ctx),
    close: (m) => mutate(() => closeTabs(ctx, Array.isArray(m.tabs) ? m.tabs : (Array.isArray(m.tabIds) ? m.tabIds : []), String(m.label || 'Manual'))),
    group: () => mutate(() => groupTabs(ctx)),
    regroup: (m) => mutate(() => regroupAll(ctx, { includeManual: m.includeManual === true })),
    undoRegroup: () => mutate(() => undoRegroup(ctx)),
    regroupState: async () => {
      const { regroupUndo } = await chrome.storage.local.get('regroupUndo');
      return { canUndo: !!regroupUndo?.groups?.length, at: regroupUndo?.at ?? null, groups: regroupUndo?.groups?.length ?? 0 };
    },
    reorder: () => mutate(() => reorderAll(ctx)),
    tidy: (m) => mutate(() => tidy(ctx, { closeIds: Array.isArray(m.closeIds) ? m.closeIds : null, steps: m.steps && typeof m.steps === 'object' ? m.steps : null }, deps2)),
    undo: () => mutate(() => undoLast(ctx)),
    search: (m) => search(ctx, m.q),
    open: (m) => openResult(ctx, m.result),
    contexts: () => listContexts(ctx),
    park: (m) => (int(m.groupId) == null ? { error: 'groupId required' } : mutate(() => parkGroup(ctx, int(m.groupId)))),
    resume: (m) => mutate(() => resumeContext(ctx, String(m.id))),
    dropContext: (m) => dropContext(ctx, String(m.id)),
    focus: async (m) => { if (int(m.tabId) == null) return { error: 'tabId required' }; await focusTab(ctx, int(m.tabId), int(m.windowId)); return { ok: true }; },
    testKey: async (m) => {
      const s = { ...(await loadSettings(chrome.storage.local)), ...(m.settings && typeof m.settings === 'object' ? m.settings : {}) };
      const r = await jevModels(s, { fetchImpl: ctx.fetch, retryDelay: ctx.jevRetryDelay });
      return { ok: true, models: (r?.data || r?.models || []).map((x) => x?.id || x?.name || x).filter((x) => typeof x === 'string') };
    },
    learn: () => learnSuggestions(ctx),
    exportTuning: () => exportTuning(ctx),
    sweep: () => mutate(() => sweepDuplicates(ctx)),
    useCaseUsage: async () => { await ctx.ready(); return useCaseUsage(ctx); },
    applyLearn: (m) => mutate(() => applyLearn(ctx, m.changes || {})),
    resetLearned: () => mutate(async () => {
      await ctx.ready();
      Object.assign(ctx.state, { usage: { urls: {}, sites: {} }, pairs: {}, tabPairs: {}, urlLineage: {}, learned: {}, managedGroups: [], useCaseStats: {} });
      await ctx.flush();
      return { ok: true };
    }),
    diagnostics: async () => {
      await ctx.ready();
      return {
        errors: ctx.state.errors.slice(-20), busy: ctx.exclusive.busy(), migratedFrom: ctx.state.migratedFrom,
        sizes: { urls: Object.keys(ctx.state.usage.urls).length, pairs: Object.keys(ctx.state.pairs).length, tabPairs: Object.keys(ctx.state.tabPairs).length, lineage: Object.keys(ctx.state.urlLineage).length, meta: Object.keys(ctx.state.meta).length },
      };
    },
  };

  async function handle(msg, sender) {
    // Only our own pages may drive the extension.
    if (sender && sender.id && sender.id !== chrome.runtime.id) return { error: 'Forbidden' };
    const route = msg && typeof msg === 'object' ? routes[msg.type] : null;
    if (!route) return { error: `Unknown message ${msg?.type}` };
    try {
      return await route(msg);
    } catch (e) {
      ctx.log(e, `msg.${msg.type}`);
      return { error: e?.message || String(e) };
    }
  }

  async function syncAlarms() {
    const s = await ctx.refreshSettings();
    await chrome.alarms.clear(ALARM);
    if (s.autoEnabled) await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(5, Number(s.autoIntervalMin) || 20) });
    if (!(await chrome.alarms.get(LEARN_ALARM))) await chrome.alarms.create(LEARN_ALARM, { periodInMinutes: 24 * 60, delayInMinutes: 60 });
    await chrome.alarms.clear(SWEEP_ALARM);
    if (s.autoCloseDuplicates) await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 5 });
  }

  async function onAlarm(a) {
    // Background jobs bow out if the user is mid-action instead of queueing behind it.
    if (a.name === ALARM) return ctx.exclusive(() => tidy(ctx, { auto: true }, deps2), { skipIfBusy: true });
    if (a.name === LEARN_ALARM) return ctx.exclusive(() => autoTune(ctx), { skipIfBusy: true });
    if (a.name === SWEEP_ALARM) return ctx.exclusive(() => sweepDuplicates(ctx), { skipIfBusy: true });
  }

  function onCommand(cmd) {
    if (cmd === 'regroup-all') return ctx.exclusive(() => regroupAll(ctx), { skipIfBusy: true });
    if (cmd === 'tidy-now') return ctx.exclusive(() => tidy(ctx, { auto: true, steps: { dedupe: true, children: true, group: true, reorder: true } }, deps2), { skipIfBusy: true });
  }

  /** Register every listener synchronously at startup, as MV3 requires. */
  function attach() {
    const g = (name, fn) => guard(name, fn, ctx.log);
    chrome.tabs.onCreated.addListener(g('tabs.onCreated', track.onCreated));
    chrome.tabs.onUpdated.addListener(g('tabs.onUpdated', track.onUpdated));
    chrome.tabs.onActivated.addListener(g('tabs.onActivated', track.onActivated));
    chrome.tabs.onRemoved.addListener(g('tabs.onRemoved', track.onRemoved));
    chrome.tabs.onReplaced.addListener(g('tabs.onReplaced', track.onReplaced));
    chrome.windows.onFocusChanged.addListener(g('windows.onFocusChanged', track.onFocusChanged));
    chrome.webNavigation.onCreatedNavigationTarget.addListener(g('nav.target', track.onCreatedNavigationTarget));
    chrome.webNavigation.onCommitted.addListener(g('nav.committed', track.onCommitted));
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    });
    chrome.commands?.onCommand.addListener(g('commands', onCommand));
    chrome.alarms.onAlarm.addListener(g('alarms', onAlarm));
    chrome.storage.onChanged.addListener(g('storage.onChanged', (changes, area) => {
      if (area === 'local' && changes.settings) { ctx.settings = null; return syncAlarms(); }
    }));
    chrome.runtime.onInstalled.addListener(g('onInstalled', async ({ reason }) => {
      await syncAlarms();
      if (reason === 'install') await chrome.runtime.openOptionsPage?.();
    }));
    chrome.runtime.onStartup.addListener(g('onStartup', async () => { await syncAlarms(); await ctx.ready(); }));
    // The worker can be stopped any time: write pending state first.
    chrome.runtime.onSuspend?.addListener(g('onSuspend', () => ctx.flush()));
    ctx.ready().catch((e) => ctx.log(e, 'startup'));
  }

  return { ctx, handle, attach, syncAlarms, onAlarm, onCommand, track };
}
