// Contexts: park a group (save + close) and resume it later as the same group, in order.
import { hashColor } from '../lib/settings.js';
import { isWebUrl } from '../lib/url.js';
import { bumpStat } from './context.js';
import { withRetry, safeRemove } from './util.js';

const MAX_PARKED = 50;

export async function getParked(ctx) {
  const { parked } = await ctx.chrome.storage.local.get('parked');
  return Array.isArray(parked) ? parked.filter((p) => p && Array.isArray(p.tabs) && p.id) : [];
}

export async function listContexts(ctx) {
  await ctx.ready();
  const { chrome } = ctx;
  const groups = await chrome.tabGroups.query({});
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const open = groups.map((g) => {
    const members = tabs.filter((t) => t.groupId === g.id).sort((a, b) => a.index - b.index);
    return { groupId: g.id, windowId: g.windowId, name: g.title || 'Untitled group', color: g.color, count: members.length, preview: members.slice(0, 3).map((t) => t.title || t.url) };
  }).filter((g) => g.count > 0);
  const parked = (await getParked(ctx)).map((p) => ({ id: p.id, name: p.name, color: p.color, count: p.tabs.length, parkedAt: p.parkedAt, preview: p.tabs.slice(0, 3).map((t) => t.title || t.url) }));
  return { open, parked };
}

/**
 * Save first, close second: if closing fails, the snapshot is still there to resume from.
 * Never leaves the last window empty (which would quit the browser).
 */
export async function parkGroup(ctx, groupId) {
  await ctx.ready();
  const { chrome } = ctx;
  let g;
  try { g = await chrome.tabGroups.get(groupId); } catch { return { parked: 0, error: 'That group no longer exists' }; }
  const members = (await chrome.tabs.query({ groupId })).sort((a, b) => a.index - b.index);
  if (!members.length) return { parked: 0 };
  if (members.some((t) => t.incognito)) return { parked: 0, error: 'Incognito groups are not saved' };
  const entry = {
    id: ctx.uuid(), name: g.title || 'Untitled group', color: g.color, parkedAt: ctx.now(),
    tabs: members.map((t) => ({ url: t.url || t.pendingUrl, title: t.title, favIconUrl: t.favIconUrl || '' })).filter((t) => t.url),
  };
  await ctx.chrome.storage.local.set({ parked: [entry, ...(await getParked(ctx))].slice(0, MAX_PARKED) });
  const inWindow = await chrome.tabs.query({ windowId: g.windowId });
  if (inWindow.length === members.length) await chrome.tabs.create({ windowId: g.windowId, active: true });
  const removed = await safeRemove(chrome, members.map((t) => t.id), ctx.timers);
  await bumpStat(ctx, 'parked', removed.length).catch(() => {});
  return { parked: removed.length, id: entry.id, name: entry.name };
}

export async function resumeContext(ctx, id) {
  await ctx.ready();
  const { chrome } = ctx;
  const parked = await getParked(ctx);
  const entry = parked.find((p) => p.id === id);
  if (!entry) return { resumed: 0, error: 'That context is gone' };
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const windowId = win?.id ?? (await chrome.windows.create({})).id;
  const ids = [];
  for (const [i, t] of entry.tabs.entries()) {
    try {
      const tab = await chrome.tabs.create({ windowId, url: isWebUrl(t.url) || /^(chrome|about|file):/.test(t.url) ? t.url : undefined, active: i === 0 });
      ids.push(tab.id);
    } catch (e) { ctx.log(e, 'resume.create'); }
  }
  if (ids.length) {
    const gid = await withRetry(() => chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }), { timers: ctx.timers });
    await chrome.tabGroups.update(gid, { title: entry.name, color: entry.color || hashColor(entry.name) });
    if (!ctx.state.managedGroups.some((n) => n.toLowerCase() === entry.name.toLowerCase())) ctx.state.managedGroups.push(entry.name);
  }
  // Only drop the snapshot once its tabs are back.
  if (ids.length === entry.tabs.length) await chrome.storage.local.set({ parked: parked.filter((p) => p.id !== id) });
  ctx.saveSoon();
  return { resumed: ids.length, name: entry.name, partial: ids.length !== entry.tabs.length };
}

export async function dropContext(ctx, id) {
  await ctx.chrome.storage.local.set({ parked: (await getParked(ctx)).filter((p) => p.id !== id) });
  return { ok: true };
}
