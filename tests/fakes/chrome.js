// In-memory fake of the Chrome extension APIs Tab Land uses. Deterministic, synchronous state,
// async API surface. Not a full emulator: it models what our code depends on, plus failure knobs.
//
// Failure knobs:
//   fake.dragLocks = n          next n tab edits throw "Tabs cannot be edited right now (user may be dragging a tab)"
//   fake.localQuotaBytes = n    storage.local.set throws a quota error when the JSON size would exceed n
//   fake.failNext[api] = Error  next call to e.g. 'tabs.remove' throws once
//   fake.permissions            Set of granted optional permissions/origins

class Event {
  constructor() { this.listeners = []; }
  addListener(fn) { this.listeners.push(fn); }
  removeListener(fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  hasListener(fn) { return this.listeners.includes(fn); }
  /** Dispatch and wait for async listeners (their promise results). */
  async dispatch(...args) {
    const out = [];
    for (const fn of this.listeners) out.push(await fn(...args));
    return out;
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function storageArea(fake, name) {
  let data = {};
  const area = {
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) for (const [k, d] of Object.entries(keys)) if (!(k in out)) out[k] = d;
      return out;
    },
    async set(items) {
      fake._maybeFail(`storage.${name}.set`);
      const next = { ...data, ...clone(items) };
      const limit = name === 'local' ? fake.localQuotaBytes : fake.sessionQuotaBytes;
      if (limit && JSON.stringify(next).length > limit) throw new Error('QUOTA_BYTES quota exceeded');
      const changes = {};
      for (const k of Object.keys(items)) changes[k] = { oldValue: data[k], newValue: clone(items[k]) };
      data = next;
      await fake.chrome.storage.onChanged.dispatch(changes, name);
    },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async clear() { data = {}; },
    _dump: () => data,
    _load: (d) => { data = clone(d); },
  };
  return area;
}

export function createFakeChrome({ now = () => Date.now() } = {}) {
  let nextTabId = 1, nextWinId = 1, nextGroupId = 1, nextSession = 1;
  const windows = new Map(); // id -> {id, focused, type, incognito}
  const tabs = new Map(); // id -> tab
  const groups = new Map(); // id -> {id, windowId, title, color, collapsed}
  const closed = []; // [{lastModified, tab}]
  const history = []; // [{url, title, visitCount, lastVisitTime}]
  const alarms = new Map();
  let lastFocused = null;

  const fake = {
    dragLocks: 0, localQuotaBytes: 0, sessionQuotaBytes: 0, failNext: {}, permissions: new Set(), scriptResults: null,
    calls: [],
    _maybeFail(api) {
      fake.calls.push(api);
      const e = fake.failNext[api];
      if (e) { delete fake.failNext[api]; throw e; }
    },
    _dragCheck() {
      if (fake.dragLocks > 0) { fake.dragLocks--; throw new Error('Tabs cannot be edited right now (user may be dragging a tab).'); }
    },
  };

  const windowTabs = (wid) => [...tabs.values()].filter((t) => t.windowId === wid).sort((a, b) => a.index - b.index);
  const reindex = (wid) => windowTabs(wid).forEach((t, i) => { t.index = i; });
  const pub = (t) => (t ? clone(t) : t);
  const getTab = (id) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return t; };
  const placeAt = (t, index) => {
    const list = windowTabs(t.windowId).filter((x) => x.id !== t.id);
    const i = Math.max(0, Math.min(index ?? list.length, list.length));
    list.splice(i, 0, t);
    list.forEach((x, k) => { x.index = k; });
  };
  /** Chrome keeps groups contiguous: gather a group's tabs next to its first member. */
  const compactGroup = (gid) => {
    const g = groups.get(gid);
    if (!g) return;
    const members = [...tabs.values()].filter((t) => t.groupId === gid).sort((a, b) => a.index - b.index);
    if (!members.length) { groups.delete(gid); return; }
    const list = windowTabs(g.windowId).filter((t) => t.groupId !== gid);
    const anchor = Math.min(...members.map((t) => t.index));
    const at = list.filter((t) => t.index < anchor).length;
    list.splice(at, 0, ...members);
    list.forEach((x, k) => { x.index = k; });
  };
  const dropEmptyGroups = () => { for (const gid of [...groups.keys()]) if (![...tabs.values()].some((t) => t.groupId === gid)) groups.delete(gid); };

  const chrome = {
    runtime: {
      id: 'fake-extension-id',
      onMessage: new Event(), onInstalled: new Event(), onStartup: new Event(), onSuspend: new Event(),
      getURL: (p) => `chrome-extension://fake-extension-id/${p}`,
      openOptionsPage: async () => { fake.calls.push('runtime.openOptionsPage'); },
      /** Test helper: deliver a message the way Chrome would, resolve with the response. */
      sendMessage: (msg, sender = { id: 'fake-extension-id' }) => new Promise((resolve) => {
        let answered = false;
        const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
        for (const fn of chrome.runtime.onMessage.listeners) {
          const keep = fn(msg, sender, respond);
          if (keep === true) return;
        }
        respond(undefined);
      }),
    },

    storage: { onChanged: new Event() },

    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: new Event(), onRemoved: new Event(),
      async getAll({ windowTypes } = {}) { return [...windows.values()].filter((w) => !windowTypes || windowTypes.includes(w.type)).map(clone); },
      async getLastFocused() { const w = windows.get(lastFocused) || [...windows.values()][0]; if (!w) throw new Error('No window'); return clone(w); },
      async get(id) { const w = windows.get(id); if (!w) throw new Error(`No window with id: ${id}.`); return clone(w); },
      async create({ url, incognito = false, focused = true } = {}) {
        const w = { id: nextWinId++, focused, type: 'normal', incognito };
        windows.set(w.id, w);
        if (focused) lastFocused = w.id;
        await chrome.tabs.create({ windowId: w.id, url: url || 'chrome://newtab/', active: true });
        return clone(w);
      },
      async update(id, { focused }) {
        const w = windows.get(id); if (!w) throw new Error(`No window with id: ${id}.`);
        if (focused) { for (const x of windows.values()) x.focused = false; w.focused = true; lastFocused = id; await chrome.windows.onFocusChanged.dispatch(id); }
        return clone(w);
      },
    },

    tabs: {
      onCreated: new Event(), onUpdated: new Event(), onActivated: new Event(), onRemoved: new Event(), onReplaced: new Event(),
      async get(id) { return pub(getTab(id)); },
      async query(q = {}) {
        let list = [...tabs.values()];
        if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        if (q.active != null) list = list.filter((t) => t.active === q.active);
        if (q.pinned != null) list = list.filter((t) => t.pinned === q.pinned);
        if (q.groupId != null) list = list.filter((t) => t.groupId === q.groupId);
        if (q.lastFocusedWindow) list = list.filter((t) => t.windowId === lastFocused);
        if (q.windowType) list = list.filter((t) => windows.get(t.windowId)?.type === q.windowType);
        return list.sort((a, b) => a.windowId - b.windowId || a.index - b.index).map(pub);
      },
      async create({ windowId, url = 'chrome://newtab/', index, active = true, pinned = false, openerTabId } = {}) {
        fake._maybeFail('tabs.create');
        let wid = windowId ?? lastFocused;
        if (wid == null || !windows.has(wid)) {
          const w = { id: nextWinId++, focused: true, type: 'normal', incognito: false };
          windows.set(w.id, w); lastFocused = w.id; wid = w.id;
        }
        const t = {
          id: nextTabId++, windowId: wid, index: 0, url, pendingUrl: undefined, title: url, active: false, pinned,
          audible: false, discarded: false, groupId: -1, incognito: windows.get(wid).incognito, lastAccessed: now(),
          favIconUrl: '', ...(openerTabId != null ? { openerTabId } : {}),
        };
        tabs.set(t.id, t);
        placeAt(t, index);
        await chrome.tabs.onCreated.dispatch(pub(t));
        if (active) await activate(t.id);
        return pub(t);
      },
      async update(id, props = {}) {
        fake._maybeFail('tabs.update');
        const t = getTab(id);
        if (props.url) { t.url = props.url; t.title = props.url; await chrome.tabs.onUpdated.dispatch(id, { url: props.url }, pub(t)); }
        if (props.pinned != null) t.pinned = props.pinned;
        if (props.active) await activate(id);
        return pub(t);
      },
      async remove(ids) {
        fake._maybeFail('tabs.remove');
        fake._dragCheck();
        const list = [].concat(ids);
        for (const id of list) getTab(id); // all-or-nothing, like Chrome
        for (const id of list) {
          const t = tabs.get(id);
          tabs.delete(id);
          closed.unshift({ lastModified: now(), tab: { ...clone(t), sessionId: String(nextSession++) } });
          reindex(t.windowId);
          if (t.active) { const next = windowTabs(t.windowId)[Math.min(t.index, windowTabs(t.windowId).length - 1)]; if (next) next.active = true; }
          await chrome.tabs.onRemoved.dispatch(id, { windowId: t.windowId, isWindowClosing: false });
          if (!windowTabs(t.windowId).length) { windows.delete(t.windowId); if (lastFocused === t.windowId) lastFocused = [...windows.keys()][0] ?? null; }
        }
        dropEmptyGroups();
      },
      async move(id, { index, windowId } = {}) {
        fake._maybeFail('tabs.move');
        fake._dragCheck();
        const t = getTab(id);
        if (windowId != null && windowId !== t.windowId) { const old = t.windowId; t.windowId = windowId; t.groupId = -1; reindex(old); }
        placeAt(t, index === -1 ? undefined : index);
        return pub(t);
      },
      async group({ tabIds, groupId, createProperties } = {}) {
        fake._maybeFail('tabs.group');
        fake._dragCheck();
        const ids = [].concat(tabIds);
        ids.forEach(getTab);
        let gid = groupId;
        if (gid == null) {
          gid = nextGroupId++;
          const wid = createProperties?.windowId ?? tabs.get(ids[0]).windowId;
          groups.set(gid, { id: gid, windowId: wid, title: '', color: 'grey', collapsed: false });
        } else if (!groups.has(gid)) throw new Error(`No group with id: ${gid}.`);
        const g = groups.get(gid);
        for (const id of ids) {
          const t = tabs.get(id);
          if (t.windowId !== g.windowId) { const old = t.windowId; t.windowId = g.windowId; reindex(old); placeAt(t); }
          t.groupId = gid;
        }
        compactGroup(gid);
        dropEmptyGroups();
        return gid;
      },
      async ungroup(ids) { for (const id of [].concat(ids)) getTab(id).groupId = -1; dropEmptyGroups(); },
      async discard(id) { const t = getTab(id); t.discarded = true; return pub(t); },
    },

    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      onUpdated: new Event(),
      async get(id) { const g = groups.get(id); if (!g) throw new Error(`No group with id: ${id}.`); return clone(g); },
      async query(q = {}) {
        return [...groups.values()].filter((g) => (q.windowId == null || g.windowId === q.windowId) && (q.title == null || g.title === q.title)).map(clone);
      },
      async update(id, props) { const g = groups.get(id); if (!g) throw new Error(`No group with id: ${id}.`); Object.assign(g, props); return clone(g); },
      async move(id, { index }) {
        fake._maybeFail('tabGroups.move');
        fake._dragCheck();
        const g = groups.get(id); if (!g) throw new Error(`No group with id: ${id}.`);
        const members = [...tabs.values()].filter((t) => t.groupId === id).sort((a, b) => a.index - b.index);
        const rest = windowTabs(g.windowId).filter((t) => t.groupId !== id);
        const at = Math.max(0, Math.min(index, rest.length));
        rest.splice(at, 0, ...members);
        rest.forEach((x, k) => { x.index = k; });
        return clone(g);
      },
    },

    webNavigation: { onCreatedNavigationTarget: new Event(), onCommitted: new Event() },

    sessions: {
      async getRecentlyClosed({ maxResults = 25 } = {}) { return closed.slice(0, maxResults).map(clone); },
      async restore(sessionId) {
        const i = closed.findIndex((c) => c.tab.sessionId === sessionId);
        if (i < 0) throw new Error('Invalid session id');
        const [c] = closed.splice(i, 1);
        const t = await chrome.tabs.create({ url: c.tab.url, windowId: windows.has(c.tab.windowId) ? c.tab.windowId : undefined });
        return { tab: t };
      },
    },

    history: {
      async search({ text = '', maxResults = 100, startTime = 0 } = {}) {
        const q = text.toLowerCase();
        return history.filter((h) => h.lastVisitTime >= startTime && (`${h.title} ${h.url}`.toLowerCase().includes(q))).slice(0, maxResults).map(clone);
      },
    },

    alarms: {
      onAlarm: new Event(),
      async create(name, info) { alarms.set(name, { name, ...info }); },
      async get(name) { return alarms.get(name) ? clone(alarms.get(name)) : undefined; },
      async clear(name) { return alarms.delete(name); },
      async getAll() { return [...alarms.values()].map(clone); },
    },

    commands: { onCommand: new Event() },

    permissions: {
      async contains({ permissions = [], origins = [] } = {}) { return [...permissions, ...origins].every((p) => fake.permissions.has(p)); },
      async request(req) { return chrome.permissions.contains(req); },
    },

    scripting: {
      async executeScript({ target }) {
        if (!fake.scriptResults) throw new Error('Cannot access contents of the page');
        return [{ result: fake.scriptResults(target.tabId) }];
      },
    },
  };
  chrome.storage.local = storageArea(fake, 'local');
  chrome.storage.session = storageArea(fake, 'session');

  async function activate(id) {
    const t = getTab(id);
    for (const x of windowTabs(t.windowId)) x.active = false;
    t.active = true;
    t.lastAccessed = now();
    await chrome.tabs.onActivated.dispatch({ tabId: id, windowId: t.windowId });
  }

  // ---- scenario helpers (what a user would do) ----
  Object.assign(fake, {
    chrome,
    /** Open a page as the user would. `from` simulates clicking a link in another tab. */
    async open(url, { title, from, windowId, active = true, transition = 'link', index } = {}) {
      const t = await chrome.tabs.create({ url, windowId: windowId ?? (from ? tabs.get(from).windowId : undefined), active: false, index, openerTabId: from });
      const tab = tabs.get(t.id);
      tab.title = title ?? url;
      if (from != null) await chrome.webNavigation.onCreatedNavigationTarget.dispatch({ sourceTabId: from, tabId: t.id, url });
      await chrome.webNavigation.onCommitted.dispatch({ tabId: t.id, frameId: 0, url, transitionType: from != null ? 'link' : transition, transitionQualifiers: [] });
      await chrome.tabs.onUpdated.dispatch(t.id, { url, title: tab.title }, pub(tab));
      if (active) await activate(t.id);
      return t.id;
    },
    activate,
    async focusWindow(id) { await chrome.windows.update(id, { focused: true }); },
    async blurAll() { lastFocused = null; await chrome.windows.onFocusChanged.dispatch(-1); },
    async navigate(id, url, { title, transition = 'link' } = {}) {
      const t = getTab(id); t.url = url; t.title = title ?? url;
      await chrome.webNavigation.onCommitted.dispatch({ tabId: id, frameId: 0, url, transitionType: transition, transitionQualifiers: [] });
      await chrome.tabs.onUpdated.dispatch(id, { url }, pub(t));
    },
    /** The user (or another extension) closes a tab out from under us. */
    async closeBehindOurBack(id) {
      const t = tabs.get(id); if (!t) return;
      tabs.delete(id); reindex(t.windowId); dropEmptyGroups();
      await chrome.tabs.onRemoved.dispatch(id, { windowId: t.windowId, isWindowClosing: false });
    },
    set(id, props) { Object.assign(getTab(id), props); },
    addHistory(entry) { history.push({ visitCount: 1, lastVisitTime: now(), title: entry.url, ...entry }); },
    async fireAlarm(name) { return chrome.alarms.onAlarm.dispatch({ name }); },
    tab: (id) => pub(tabs.get(id)),
    allTabs: () => [...tabs.values()].sort((a, b) => a.windowId - b.windowId || a.index - b.index).map(pub),
    allGroups: () => [...groups.values()].map(clone),
    windowIds: () => [...windows.keys()],
    async newWindow(opts) { return (await chrome.windows.create(opts)).id; },
  });

  return fake;
}
