// Settings schema + defaults. Stored in chrome.storage.local (never sync: it holds an API key).

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export const DEFAULT_USE_CASES = [
  { name: 'Comms', color: 'blue', description: 'Email, chat, Slack, messaging, inbox triage' },
  { name: 'Meetings', color: 'cyan', description: 'Calendar, meeting notes, video calls, scheduling' },
  { name: 'Engineering', color: 'purple', description: 'Code, pull requests, issues, CI/CD, cloud consoles, logs, developer docs' },
  { name: 'Product', color: 'pink', description: 'Specs, roadmaps, tickets, design files, prototypes' },
  { name: 'Growth', color: 'orange', description: 'Marketing, ads, SEO, social, campaigns, web analytics' },
  { name: 'Sales', color: 'green', description: 'CRM, deals, partnerships, outreach, customer accounts' },
  { name: 'Hiring', color: 'yellow', description: 'Recruiting, candidates, ATS, job posts, interview loops, profiles' },
  { name: 'Finance & Ops', color: 'grey', description: 'Banking, billing, invoices, payroll, legal, contracts, admin' },
  { name: 'Data', color: 'cyan', description: 'Dashboards, SQL, notebooks, metrics, spreadsheets of numbers' },
  { name: 'Research', color: 'red', description: 'Articles, papers, docs, references being read or compared' },
  { name: 'AI Tools', color: 'purple', description: 'AI assistants and chat tools' },
  { name: 'Personal', color: 'grey', description: 'Shopping, travel, news, entertainment, personal errands' },
];

export const DEFAULTS = {
  // TypeSafe AI (Jev)
  jevApiKey: '',
  jevBaseUrl: 'https://api.typesafe.ai',
  jevModel: 'jev-latest',
  jevTimeoutMs: 15000,
  useJevForGrouping: true,
  groupingMode: 'goals',   // 'goals' (the job a set of tabs serves) or 'useCases' (the kind of work)
  goalThreshold: 0.3,
  minGroupSize: 4,           // no groups smaller than this: small clusters merge into a bigger goal or stay loose
  readPageText: false,     // read page descriptions/headings locally to improve goals (needs page access)
  useJevForClosing: true,
  useCases: DEFAULT_USE_CASES,
  minChoiceConfidence: 0.45,
  autoTuneUseCases: true,  // daily: refresh each use case's learned sites (never adds/removes)

  // Privacy: what tab data may leave the browser
  sendTitles: true,
  sendPaths: true,
  aiExcludedDomains: [],   // never sent to Jev
  protectedDomains: [],    // never closed or moved

  // Cleanup behavior
  staleMinutes: 30,
  transientMinutes: 10,
  autoCloseConfidence: 0.85,
  crossWindowDedupe: true,
  closeVariants: true,       // versions of the same page (?…, #…) are details of one master
  autoCloseDuplicates: true, // close unused copies and versions on their own
  dupIdleMinutes: 10,        // how long a copy or version must sit unused before it goes
  respectManualGroups: true,
  reorderGroupsAsBlocks: true,
  groupOrder: 'recent',       // 'recent': the group you used last goes to the end; 'usage': most used first
  autoOrderGroups: true,      // put groups in order every autoIntervalMin minutes (not while you switch tabs)
  halfLifeDays: 3,
  linkInference: false,

  // Automation
  autoEnabled: false,
  autoIntervalMin: 20,
  autoDedupe: true,
  autoCloseChildren: false,
  autoGroup: false,
  autoReorder: false,
};

const COLOR_SET = new Set(GROUP_COLORS);

/**
 * Validate stored settings against DEFAULTS. Wrong types fall back to the default; use cases are
 * filtered to well-formed entries. A corrupt or old settings object can never break the extension.
 */
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULTS };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = src[k];
    if (v === undefined) continue;
    if (Array.isArray(def)) { if (Array.isArray(v)) out[k] = v; }
    else if (typeof def === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else if (typeof v === typeof def) out[k] = v;
  }
  out.useCases = (Array.isArray(out.useCases) ? out.useCases : DEFAULT_USE_CASES)
    .filter((u) => u && typeof u.name === 'string' && u.name.trim())
    .map((u) => ({
      name: u.name.trim().slice(0, 40),
      color: COLOR_SET.has(u.color) ? u.color : hashColor(u.name),
      description: typeof u.description === 'string' ? u.description : '',
      ...(Array.isArray(u.sites) ? { sites: u.sites.filter((x) => typeof x === 'string').slice(0, 10) } : {}),
      ...(u.learned ? { learned: true } : {}),
    }));
  for (const k of ['aiExcludedDomains', 'protectedDomains']) out[k] = out[k].filter((d) => typeof d === 'string');
  out.autoCloseConfidence = Math.min(0.99, Math.max(0.5, out.autoCloseConfidence));
  out.minChoiceConfidence = Math.min(0.95, Math.max(0.05, out.minChoiceConfidence));
  out.halfLifeDays = Math.min(60, Math.max(0.1, out.halfLifeDays));
  out.staleMinutes = Math.max(0, out.staleMinutes);
  out.autoIntervalMin = Math.max(5, out.autoIntervalMin);
  out.jevTimeoutMs = Math.min(60000, Math.max(2000, out.jevTimeoutMs));
  if (!['goals', 'useCases'].includes(out.groupingMode)) out.groupingMode = DEFAULTS.groupingMode;
  out.minGroupSize = Math.max(2, Math.min(10, Math.round(Number(out.minGroupSize)) || DEFAULTS.minGroupSize));
  if (!['recent', 'usage'].includes(out.groupOrder)) out.groupOrder = DEFAULTS.groupOrder;
  out.goalThreshold = Math.min(0.9, Math.max(0.1, out.goalThreshold));
  out.dupIdleMinutes = Math.min(1440, Math.max(1, out.dupIdleMinutes));
  return out;
}

export async function loadSettings(area = chrome.storage.local) {
  const { settings } = await area.get('settings');
  return sanitizeSettings(settings);
}

export async function saveSettings(patch, area = chrome.storage.local) {
  const cur = await loadSettings(area);
  const next = sanitizeSettings({ ...cur, ...patch });
  await area.set({ settings: next });
  return next;
}

export function hashColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}
