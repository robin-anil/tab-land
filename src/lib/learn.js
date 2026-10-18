// Learning use cases from real browsing.
// Evidence: which use case each grouped tab landed in (and from which site), plus site usage and co-usage.
// Output: suggestions to add, retire or enrich use cases. Nothing changes until the user applies it
// (or turns on auto-tune, which only ever adds learned sites, never removes a use case).
import { decay, pairWeight } from './scoring.js';
import { prettySite } from './url.js';

/** Names Jev can choose from when naming a discovered cluster. Jev picks; it never invents text. */
export const USE_CASE_VOCAB = [
  ['Email', 'Inbox, email threads, newsletters'], ['Chat', 'Slack, Teams, Discord, messaging'],
  ['Calendar', 'Calendar, scheduling, meeting invites'], ['Meetings', 'Video calls, meeting notes, transcripts'],
  ['Code Review', 'Pull requests, diffs, code review'], ['Engineering', 'Repos, issues, CI/CD, developer docs'],
  ['Infrastructure', 'Cloud consoles, servers, DNS, deploys, monitoring'], ['Incidents', 'Alerts, error tracking, logs, on-call'],
  ['Product', 'Specs, roadmaps, PRDs, product tickets'], ['Design', 'Figma, mockups, prototypes, design systems'],
  ['Project Management', 'Boards, sprints, task trackers'], ['Docs & Notes', 'Docs, wikis, notes, knowledge bases'],
  ['Data', 'Dashboards, SQL, notebooks, metrics'], ['Analytics', 'Web and product analytics, funnels, attribution'],
  ['Growth', 'Growth experiments, landing pages, conversion'], ['Marketing', 'Campaigns, content, brand, email marketing'],
  ['SEO', 'Search rankings, keywords, backlinks, site audits'], ['Ads', 'Ad managers, paid social, paid search'],
  ['Social', 'Social media posting and feeds'], ['Content', 'Blog posts, writing, editing, CMS'],
  ['Sales', 'CRM, deals, pipeline, outreach'], ['Partnerships', 'Partners, referral programs, affiliates'],
  ['Customer Support', 'Support tickets, help desk, customer chats'], ['Customer Success', 'Accounts, onboarding, renewals'],
  ['Hiring', 'Recruiting, ATS, candidates, job posts'], ['People & HR', 'HR systems, benefits, onboarding employees'],
  ['Payroll', 'Payroll, contractor payments, 1099s'], ['Finance', 'Accounting, budgets, forecasts, spend'],
  ['Banking', 'Bank accounts, transfers, cards'], ['Billing', 'Invoices, subscriptions, payments, revenue'],
  ['Fundraising', 'Investors, data rooms, cap tables, decks'], ['Legal', 'Contracts, e-signature, legal review'],
  ['Compliance', 'Security, privacy, audits, policies, BAAs'], ['Operations', 'Ops tools, vendors, procurement, admin'],
  ['Clinical Ops', 'Clinician scheduling, credentialing, care operations'], ['Health Records', 'EHR, patient charts, clinical systems'],
  ['Insurance & Claims', 'Payers, claims, eligibility, prior auth'], ['Research', 'Articles, papers, references, comparisons'],
  ['Learning', 'Courses, tutorials, documentation being studied'], ['AI Tools', 'AI assistants, model playgrounds, prompts'],
  ['News', 'News sites, industry news'], ['Reading', 'Long reads, blogs, saved articles'],
  ['Video', 'YouTube, streaming, recorded talks'], ['Music', 'Music and podcasts'],
  ['Shopping', 'Online stores, carts, orders'], ['Travel', 'Flights, hotels, maps, itineraries'],
  ['Food', 'Recipes, restaurants, delivery'], ['Home', 'Real estate, home services, utilities'],
  ['Health', 'Personal health, fitness, appointments'], ['Personal Finance', 'Investing, budgeting, personal accounts'],
  ['Events', 'Conferences, tickets, RSVPs'], ['Office', 'Office space, facilities, equipment'],
  ['Admin', 'Account settings, IT admin, workspace admin'], ['Personal', 'Personal errands and everything else'],
];

/** Fold one grouping run into per-use-case evidence. assign: Map<tabId,{name}> ; siteOf: tabId -> siteKey */
export function recordAssignments(stats, assign, siteOf, now) {
  const out = { ...stats };
  for (const [tabId, a] of assign) {
    const key = a.name;
    const e = out[key] ? { ...out[key], sites: { ...out[key].sites } } : { n: 0, t: now, sites: {} };
    e.n += 1;
    e.t = now;
    const sk = siteOf(tabId);
    if (sk) e.sites[sk] = (e.sites[sk] || 0) + 1;
    out[key] = e;
  }
  return out;
}

/**
 * Discover clusters of heavily used sites that are used together but don't belong to a use case yet.
 * Union-find over co-usage edges between "strong" sites.
 */
export function discoverClusters({ sites = {}, pairs = {}, covered = new Set(), now = Date.now(), halfLifeMs, minSiteScore = 3, minPair = 1.5, max = 6 }) {
  const strong = Object.entries(sites)
    .map(([k, v]) => [k, decay(v.s, v.t, now, halfLifeMs)])
    .filter(([k, s]) => s >= minSiteScore && !covered.has(k) && !k.startsWith('chrome'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60);
  const parent = new Map(strong.map(([k]) => [k, k]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      if (pairWeight(pairs, strong[i][0], strong[j][0], now, halfLifeMs) >= minPair) parent.set(find(strong[i][0]), find(strong[j][0]));
    }
  }
  const groups = new Map();
  for (const [k, s] of strong) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, { sites: [], score: 0 });
    const g = groups.get(r);
    g.sites.push(k);
    g.score += s;
  }
  return [...groups.values()]
    .filter((g) => g.sites.length >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((g) => ({ ...g, fallbackName: g.sites.slice(0, 2).map(prettySite).join(' + ') }));
}

/** Top sites per use case, by evidence count. */
export function topSites(entry, n = 5) {
  return Object.entries(entry?.sites || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

/**
 * Suggestions:
 *  add     — discovered clusters (name chosen later by Jev or fallback)
 *  retire  — use cases with no evidence for `staleDays` (only once there's enough evidence overall)
 *  enrich  — use cases whose learned sites differ from what's saved on them
 */
export function suggestChanges({ useCases, stats = {}, clusters = [], now = Date.now(), staleDays = 14, minEvidence = 20 }) {
  const total = Object.values(stats).reduce((a, e) => a + e.n, 0);
  const lower = new Set(useCases.map((u) => u.name.toLowerCase()));
  const add = clusters.filter((c) => !lower.has((c.name || c.fallbackName).toLowerCase()));
  const retire = total >= minEvidence
    ? useCases.filter((u) => { const e = stats[u.name]; return !e || now - e.t > staleDays * 864e5; }).map((u) => u.name)
    : [];
  const enrich = [];
  for (const u of useCases) {
    const learned = topSites(stats[u.name]);
    if (!learned.length) continue;
    const saved = u.sites || [];
    if (learned.join() !== saved.join()) enrich.push({ name: u.name, sites: learned, previous: saved });
  }
  return { add, retire, enrich, evidence: total };
}

/** Description Jev sees: the user's words plus the sites this use case really contains. */
export function describeUseCase(u) {
  const base = u.description || u.name;
  return u.sites?.length ? `${base}. Usually on: ${u.sites.slice(0, 5).join(', ')}` : base;
}
