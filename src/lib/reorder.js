// Plan a usage-ordered layout for one window. Pinned tabs stay put; groups move as blocks.

/**
 * @param {Array} tabs  tabs of ONE window (any order)
 * @param {(t)=>number} scoreOf
 * @returns {{startIndex:number, units:Array<{type:'tab',tabId}|{type:'group',groupId,tabIds}>, changed:boolean}}
 */
export function planWindowOrder(tabs, scoreOf, { groupsAsUnits = true } = {}) {
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
  for (const u of units) {
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
  units.sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex);

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
