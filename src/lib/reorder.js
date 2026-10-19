// Plan the layout of one window. Pinned tabs stay put; groups move as blocks.
//   order 'usage'  most-used first (frecency score)
//   order 'recent' least recently used first, so the group you used last sits at the end, and inside each
//                  group the tab you used last sits at its end

/**
 * @param {Array} tabs  tabs of ONE window (any order)
 * @param {(t)=>number} scoreOf
 * @returns {{startIndex:number, units:Array<{type:'tab',tabId}|{type:'group',groupId,tabIds}>, changed:boolean}}
 */
export function planWindowOrder(tabs, scoreOf, { groupsAsUnits = true, order = 'usage', lastUsed = (t) => Math.max(t.lastActivated || 0, t.lastAccessed || 0) } = {}) {
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const pinned = sorted.filter((t) => t.pinned);
  const rest = sorted.filter((t) => !t.pinned);

  /** @type {any[]} */
  const units = [];
  const groupUnits = new Map();
  for (const t of rest) {
    if (groupsAsUnits && t.groupId != null && t.groupId >= 0) {
      if (!groupUnits.has(t.groupId)) {
        const u = { type: 'group', groupId: t.groupId, tabs: [], firstIndex: t.index };
        groupUnits.set(t.groupId, u);
        units.push(u);
      }
      groupUnits.get(t.groupId).tabs.push(t);
    } else {
      units.push({ type: 'tab', tabId: t.id, tab: t, firstIndex: t.index });
    }
  }
  if (order === 'recent') {
    for (const u of units) {
      u.score = u.type === 'group' ? Math.max(...u.tabs.map(lastUsed)) : lastUsed(u.tab);
      if (u.type === 'group') { u.tabs.sort((a, b) => lastUsed(a) - lastUsed(b) || a.index - b.index); u.tabIds = u.tabs.map((t) => t.id); }
    }
    units.sort((a, b) => a.score - b.score || a.firstIndex - b.firstIndex);
  } else for (const u of units) {
    if (u.type === 'group') {
      u.tabs.sort((a, b) => scoreOf(b) - scoreOf(a) || a.index - b.index);
      const scores = u.tabs.map(scoreOf);
      const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
      u.score = Math.max(...scores) + 0.25 * mean;
      u.tabIds = u.tabs.map((t) => t.id);
    } else {
      u.score = scoreOf(u.tab);
    }
  }
  if (order !== 'recent') units.sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex);

  const target = units.flatMap((u) => (u.type === 'group' ? u.tabIds : [u.tabId]));
  const current = rest.map((t) => t.id);
  const changed = target.some((id, i) => id !== current[i]);

  return {
    startIndex: pinned.length,
    changed,
    units: units.map((u) => (u.type === 'group'
      ? { type: 'group', groupId: u.groupId, tabIds: u.tabIds }
      : { type: 'tab', tabId: u.tabId })),
  };
}
