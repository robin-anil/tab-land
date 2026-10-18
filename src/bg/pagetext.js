// Optional: read a page's description and headings to sharpen goal grouping.
// Runs inside the page, stays in memory, and is never stored or sent to Jev.
import { isWebUrl, normalizeUrl } from '../lib/url.js';

const TTL_MS = 30 * 60e3;
const MAX_TABS = 40;

/** Executed in the page. Kept dependency-free and small. */
function readPage() {
  const meta = (n) => document.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.getAttribute('content') || '';
  const heads = [...document.querySelectorAll('h1, h2')].slice(0, 6).map((h) => /** @type {HTMLElement} */ (h).innerText || '').join(' · ');
  return [meta('description'), meta('og:description'), heads].filter(Boolean).join(' · ').slice(0, 1500);
}

export async function pageTextFor(ctx, tabs) {
  const out = new Map();
  const { chrome } = ctx;
  if (!ctx.settings.readPageText || !chrome.scripting) return out;
  if (!(await chrome.permissions.contains({ permissions: ['scripting'], origins: ['<all_urls>'] }).catch(() => false))) return out;
  ctx.pageTextCache ||= new Map();
  const now = ctx.now();
  const todo = [];
  for (const t of tabs) {
    // Excluded domains (e.g. an EHR) are never read, even locally. Neither are incognito or unloaded tabs.
    if (!isWebUrl(t.url) || t.discarded || t.incognito || !ctx.aiAllowed(t)) continue;
    const hit = ctx.pageTextCache.get(t.id);
    if (hit && hit.url === normalizeUrl(t.url) && now - hit.at < TTL_MS) { out.set(t.id, hit.text); continue; }
    todo.push(t);
  }
  await Promise.all(todo.slice(0, MAX_TABS).map(async (t) => {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: readPage });
      const text = typeof r?.result === 'string' ? r.result : '';
      ctx.pageTextCache.set(t.id, { url: normalizeUrl(t.url), at: now, text });
      if (text) out.set(t.id, text);
    } catch { /* restricted page (chrome://, web store, PDF viewer) */ }
  }));
  return out;
}
