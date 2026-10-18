// A realistic, messy set of open tabs with the goal each one "really" belongs to (null = one-off).
// Used to measure grouping coverage and accuracy.
let n = 0;
const T = (goal, url, title, extra = {}) => ({ goal, tab: { id: ++n, url, title, windowId: 1, index: n, openedAt: 0, ...extra } });

export const WORKDAY = [
  // Billing incident spread across tools
  T('incident', 'https://linear.app/acme/issue/ENG-482/billing-retry-fails', 'ENG-482 Billing retry fails for NJ claims'),
  T('incident', 'https://github.com/acme/api/pull/91', 'Fix billing retry backoff (ENG-482) · Pull Request #91 · acme/api'),
  T('incident', 'https://docs.google.com/document/d/abc', 'Billing retry runbook - Google Docs'),
  T('incident', 'https://acme.sentry.io/issues/4412/', 'RetryError: claim submission timed out — api — Sentry'),
  T('incident', 'https://app.datadoghq.com/dashboard/x/billing', 'Billing service latency | Datadog'),
  T('incident', 'https://github.com/acme/api/actions/runs/88', 'fix billing retry backoff · acme/api@4f2c1 · GitHub Actions'),
  // Hiring a therapist
  T('hiring', 'https://app.ashbyhq.com/candidates/123', 'Jane Doe – Senior Therapist – Ashby'),
  T('hiring', 'https://www.linkedin.com/in/janedoe', 'Jane Doe | LinkedIn'),
  T('hiring', 'https://mail.google.com/mail/u/0/#inbox/abc', 'Interview: Jane Doe, Senior Therapist - Gmail'),
  T('hiring', 'https://calendar.google.com/calendar/u/0/r/eventedit/xyz', 'Jane Doe interview loop - Google Calendar'),
  T('hiring', 'https://docs.google.com/document/d/scorecard', 'Senior Therapist interview scorecard - Google Docs'),
  // Board deck
  T('board', 'https://docs.google.com/presentation/d/deck', 'Q4 Board Deck - Google Slides'),
  T('board', 'https://docs.google.com/spreadsheets/d/model', 'Q4 board metrics model - Google Sheets'),
  T('board', 'https://app.hex.tech/acme/app/revenue', 'Revenue by payer Q4 | Hex'),
  T('board', 'https://notion.so/acme/Board-meeting-prep-Q4', 'Board meeting prep Q4 – Notion'),
  // Paid ads campaign
  T('ads', 'https://ads.google.com/aw/campaigns', 'Campaigns – Google Ads'),
  T('ads', 'https://business.facebook.com/adsmanager/manage/campaigns', 'Ads Manager - Manage ads - Campaigns'),
  T('ads', 'https://docs.google.com/spreadsheets/d/adspend', 'Paid campaigns spend tracker - Google Sheets'),
  T('ads', 'https://app.orchard.example/creatives', 'Creatives – Orchard'),
  // Signup redesign
  T('signup', 'https://figma.com/file/x/Onboarding-v3', 'Onboarding v3 – Figma'),
  T('signup', 'https://linear.app/acme/issue/DES-9/signup-flow-polish', 'DES-9 Signup flow polish'),
  T('signup', 'https://github.com/acme/web/pull/120', 'Signup flow: new onboarding steps (DES-9) · Pull Request #120 · acme/web'),
  // One-offs
  T(null, 'https://www.youtube.com/watch?v=1', 'lofi beats to code to - YouTube'),
  T(null, 'https://news.ycombinator.com/item?id=1', 'Show HN: A tiny tab manager | Hacker News'),
  T(null, 'https://www.nytimes.com/2026/10/18/world/x.html', 'World news today - The New York Times'),
  T(null, 'https://github.com/acme/web/pull/5', 'Update marketing footer · Pull Request #5 · acme/web'),
  T(null, 'https://www.amazon.com/dp/B0X', 'Standing desk mat - Amazon.com'),
];

/** Pairwise accuracy: of the pairs we put together, how many truly belong together; of true pairs, how many we found. */
export function score(groups, items = WORKDAY) {
  const together = new Set();
  for (const g of groups) for (const a of g) for (const b of g) if (a < b) together.add(`${a}|${b}`);
  let truePairs = 0, found = 0, correct = 0;
  for (const x of items) for (const y of items) {
    if (x.tab.id >= y.tab.id) continue;
    const same = x.goal && x.goal === y.goal;
    const ours = together.has(`${x.tab.id}|${y.tab.id}`);
    if (same) truePairs++;
    if (ours) { found++; if (same) correct++; }
  }
  const grouped = new Set(groups.flat());
  const shouldGroup = items.filter((x) => x.goal).length;
  return {
    coverage: grouped.size / shouldGroup,               // share of goal tabs that got a group
    precision: found ? correct / found : 1,             // pairs we joined that are right
    recall: truePairs ? correct / truePairs : 1,        // right pairs we found
    strays: items.filter((x) => !x.goal && grouped.has(x.tab.id)).length,
  };
}
