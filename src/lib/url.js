// URL helpers: normalization for dedupe, site keys for usage/co-usage, page-type heuristics.

const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i, /^msclkid$/i,
  /^mc_(cid|eid)$/i, /^_hs(enc|mi)$/i, /^hsa_/i, /^ref_?(src|source)?$/i, /^igshid$/i,
  /^yclid$/i, /^_ga$/i, /^_gl$/i, /^oly_(anon|enc)_id$/i, /^vero_/i, /^mkt_tok$/i,
  /^trk$/i, /^trkCampaign$/i, /^li_fat_id$/i, /^s_cid$/i, /^spm$/i, /^__s$/i,
];

// Hosts that route with the hash fragment, so "#inbox" and "#sent" are different pages.
const HASH_ROUTED_HOSTS = new Set([
  'mail.google.com', 'calendar.google.com', 'outlook.office.com', 'outlook.office365.com',
  'outlook.live.com', 'web.whatsapp.com',
]);

// Hosts that contain many unrelated "apps"/projects; the site key includes N path segments.
const MULTI_APP_HOSTS = {
  'github.com': 2, 'gitlab.com': 2, 'bitbucket.org': 2,
  'docs.google.com': 1, 'drive.google.com': 1, 'console.cloud.google.com': 1,
  'linear.app': 1, 'notion.so': 1, 'app.hubspot.com': 1, 'figma.com': 1,
  'vercel.com': 1, 'app.slack.com': 2, 'reddit.com': 2, 'medium.com': 1,
};

const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.in',
  'co.jp', 'com.br', 'com.mx', 'com.sg', 'com.hk', 'co.za', 'com.tr', 'co.kr',
]);

export function parseUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

export function isWebUrl(raw) {
  const u = parseUrl(raw);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

export function hostOf(raw) {
  const u = parseUrl(raw);
  return u ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
}

export function registrableDomain(host) {
  if (!host) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function pathSegments(raw) {
  const u = parseUrl(raw);
  if (!u) return [];
  return u.pathname.split('/').filter(Boolean);
}

/** Canonical form used to detect exact duplicates. */
export function normalizeUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return raw || '';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // chrome://newtab/ and chrome://newtab are the same thing
    return raw.replace(/\/+$/, '');
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = u.port ? `:${u.port}` : '';
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const params = [...u.searchParams]
    .filter(([k]) => !TRACKING_PARAMS.some((r) => r.test(k)))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  let hash = '';
  const h = u.hash.slice(1);
  if (h && (HASH_ROUTED_HOSTS.has(host) || h.startsWith('/') || h.startsWith('!'))) hash = '#' + h;
  return `${u.protocol}//${host}${port}${path}${query}${hash}`;
}

// Query parameters that change *which* page you're on. Everything else (view settings, sorting,
// tracking, session junk) only changes how the same page looks, so it doesn't define the page.
const IDENTITY_PARAMS_BY_HOST = {
  'youtube.com': ['v', 'list'], 'm.youtube.com': ['v', 'list'], 'youtu.be': [],
  'google.com': ['q', 'tbm'], 'bing.com': ['q'], 'duckduckgo.com': ['q'], 'search.brave.com': ['q'],
  'news.ycombinator.com': ['id'], 'amazon.com': [],
};
// Search queries (q) only define the page on search engines; elsewhere they filter a list (a detail).
const IDENTITY_PARAMS = new Set(['id', 'v', 'p', 'pid', 'page_id', 'pageid', 'item', 'itemid', 'item_id',
  'article', 'articleid', 'post', 'postid', 'story', 'doc', 'docid', 'file', 'fileid', 'sku', 'product', 'productid',
  'ticket', 'ticketid', 'issue', 'thread', 'threadid', 'message', 'msg', 'msgid', 'case', 'caseid', 'order', 'orderid',
  'invoice', 'record', 'recordid', 'patient', 'chart', 'list', 'wiki', 'title', 'curid']);

/**
 * The page a URL is a version of: its master. Two tabs with the same pageKey show the same page,
 * differing only in details (view settings, filters, #section jumps, tracking). Hash-routed apps
 * (Gmail, Outlook) and "#/" single-page routes keep their route, minus any route parameters.
 */
export function pageKey(raw) {
  const u = parseUrl(raw);
  if (!u) return raw || '';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return normalizeUrl(raw);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = u.port ? `:${u.port}` : '';
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const allow = IDENTITY_PARAMS_BY_HOST[host] || IDENTITY_PARAMS_BY_HOST[registrableDomain(host)];
  const keep = (k) => (allow ? allow.includes(k) : IDENTITY_PARAMS.has(k.toLowerCase()));
  const params = [...u.searchParams].filter(([k, v]) => v !== '' && keep(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  let hash = '';
  const h = u.hash.slice(1);
  if (h && (HASH_ROUTED_HOSTS.has(host) || h.startsWith('/') || h.startsWith('!'))) hash = '#' + h.split('?')[0].replace(/\/+$/, '');
  return `${u.protocol}//${host}${port}${path}${query}${hash}`;
}

/** How many detail parts (non-identity params, hash) a URL carries; the plain page has 0. */
export function detailWeight(raw) {
  const u = parseUrl(raw);
  if (!u) return 0;
  return [...u.searchParams].length + (u.hash.length > 1 ? 1 : 0);
}

/** Coarse "what app/project is this" key used for usage and co-usage statistics. */
export function siteKey(raw) {
  const u = parseUrl(raw);
  if (!u) return raw || '';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol + '//' + u.hostname;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const depth = MULTI_APP_HOSTS[host] || 0;
  if (!depth) return host;
  const segs = u.pathname.split('/').filter(Boolean).slice(0, depth);
  return [host, ...segs].join('/');
}

/** Path for display / AI context — no query string or fragment. */
export function displayPath(raw, max = 80) {
  const u = parseUrl(raw);
  if (!u) return '';
  const p = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
  return p.length > max ? p.slice(0, max - 1) + '…' : p;
}

const LIST_PATH = /\/(search|results|issues|pulls|merge_requests|inbox|list|lists|browse|explore|feed|category|categories|tag|tags|topics|collections|board|boards|projects|tickets|queue|dashboard|home|active|all|backlog|latest|new|popular|trending)\/?$/i;
const LIST_PARAMS = ['q', 'query', 'search', 's', 'keyword', 'keywords', 'k', 'term', 'p', 'page', 'filter', 'sort'];

/** Hub-like pages that spawn child tabs: search results, lists, inboxes, boards. */
export function isListPage(raw) {
  const u = parseUrl(raw);
  if (!u) return false;
  if (LIST_PARAMS.some((k) => u.searchParams.has(k))) return true;
  if (LIST_PATH.test(u.pathname)) return true;
  if (u.pathname === '/' || u.pathname === '') return true;
  return false;
}

const TRANSIENT_PATH = /(^|\/|[-_])(oauth2?|authorize|signin|sign-in|login|logout|log-in|callback|sso|saml|redirect|consent|verify|auth)([-_/.]|$)/i;
const TRANSIENT_HOSTS = new Set([
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com',
  'auth0.com', 'id.atlassian.com',
]);

/** Pages that are by nature throwaway once done: auth flows, redirects, blank tabs. */
export function isTransientPage(raw) {
  if (!raw || raw === 'about:blank') return true;
  const u = parseUrl(raw);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (TRANSIENT_HOSTS.has(host)) return true;
  return TRANSIENT_PATH.test(u.pathname);
}

export function matchesDomain(host, list) {
  if (!host || !list || !list.length) return false;
  const h = host.toLowerCase().replace(/^www\./, '');
  return list.some((d) => {
    const dd = String(d).trim().toLowerCase().replace(/^www\./, '').replace(/^\*\./, '');
    return dd && (h === dd || h.endsWith('.' + dd));
  });
}

const PRETTY = {
  'mail.google.com': 'Gmail', 'calendar.google.com': 'Calendar', 'docs.google.com/document': 'Docs',
  'docs.google.com/spreadsheets': 'Sheets', 'docs.google.com/presentation': 'Slides',
  'drive.google.com': 'Drive', 'github.com': 'GitHub', 'linear.app': 'Linear', 'notion.so': 'Notion',
  'app.slack.com': 'Slack', 'figma.com': 'Figma', 'youtube.com': 'YouTube',
};

export function prettySite(key) {
  if (PRETTY[key]) return PRETTY[key];
  const host = key.split('/')[0];
  if (PRETTY[host]) return PRETTY[host];
  const base = registrableDomain(host).split('.')[0] || host;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
