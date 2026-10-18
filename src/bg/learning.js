// Learning use cases from evidence: suggestions, applying them, and the daily auto-tune.
import { saveSettings, hashColor } from '../lib/settings.js';
import { siteKey, matchesDomain } from '../lib/url.js';
import { discoverClusters, suggestChanges, topSites, USE_CASE_VOCAB } from '../lib/learn.js';
import { runAll, buildNamingRequests, parseNamingResponses } from '../lib/jev.js';
import { snapshot } from './context.js';

export function useCaseUsage(ctx) {
  return Object.fromEntries(Object.entries(ctx.state.useCaseStats).map(([k, v]) => [k, { n: v.n, t: v.t, sites: topSites(v) }]));
}

export async function learnSuggestions(ctx) {
  await ctx.ready();
  const s = await ctx.refreshSettings();
  const now = ctx.now();
  const covered = new Set();
  for (const u of s.useCases) for (const k of [...(u.sites || []), ...topSites(ctx.state.useCaseStats[u.name], 8)]) covered.add(k);
  const excluded = (k) => matchesDomain(k.split('/')[0], s.aiExcludedDomains);
  const clusters = discoverClusters({ sites: ctx.state.usage.sites, pairs: ctx.state.pairs, covered, now, halfLifeMs: ctx.hl() })
    .map((c) => ({ ...c, sites: c.sites.filter((k) => !excluded(k)) }))
    .filter((c) => c.sites.length >= 2);

  const tabs = await snapshot(ctx);
  for (const c of clusters) {
    c.titles = tabs.filter((t) => c.sites.includes(siteKey(t.url)) && ctx.aiAllowed(t)).map((t) => t.title).filter(Boolean);
    c.name = c.fallbackName;
    c.via = 'sites';
  }
  let jevError = null;
  if (s.jevApiKey && clusters.length) {
    const reqs = buildNamingRequests(clusters, { settings: s, exclude: s.useCases.map((u) => u.name) });
    const { results, errors } = await runAll(s, reqs.map((r) => ({ body: r.body })), { fetchImpl: ctx.fetch, retryDelay: ctx.jevRetryDelay });
    const names = parseNamingResponses(reqs, results);
    const used = new Set();
    names.forEach((n, i) => {
      if (n && n.confidence >= 0.35 && !used.has(n.name)) { Object.assign(clusters[i], { name: n.name, via: 'jev', confidence: n.confidence }); used.add(n.name); }
    });
    if (errors.length && !names.some(Boolean)) jevError = errors[0].message;
  }
  const vocab = Object.fromEntries(USE_CASE_VOCAB);
  for (const c of clusters) {
    c.description = vocab[c.name] || `Work across ${c.sites.slice(0, 3).join(', ')}`;
    c.color = hashColor(c.name);
  }
  const sug = suggestChanges({ useCases: s.useCases, stats: ctx.state.useCaseStats, clusters, now });
  return {
    add: sug.add.map((c) => ({ name: c.name, sites: c.sites, description: c.description, color: c.color, via: c.via })),
    retire: sug.retire, enrich: sug.enrich, evidence: sug.evidence, usage: useCaseUsage(ctx), jevError,
  };
}

export async function applyLearn(ctx, { add = [], retire = [], enrich = [] } = {}) {
  const cur = await ctx.refreshSettings();
  let useCases = cur.useCases.filter((u) => !retire.includes(u.name));
  const sitesFor = Object.fromEntries((enrich || []).filter((e) => e?.name && Array.isArray(e.sites)).map((e) => [e.name, e.sites]));
  useCases = useCases.map((u) => (sitesFor[u.name] ? { ...u, sites: sitesFor[u.name] } : u));
  for (const a of add || []) {
    if (!a?.name || useCases.some((u) => u.name.toLowerCase() === a.name.toLowerCase())) continue;
    useCases.push({ name: a.name, color: a.color || hashColor(a.name), description: a.description || a.name, sites: a.sites || [], learned: true });
  }
  ctx.settings = await saveSettings({ useCases }, ctx.chrome.storage.local);
  return { useCases: ctx.settings.useCases };
}

/** Daily: refresh learned sites only. Never adds or removes a use case on its own. */
export async function autoTune(ctx) {
  const s = await ctx.refreshSettings();
  if (!s.autoTuneUseCases) return { skipped: true };
  const sug = await learnSuggestions(ctx);
  if (sug.enrich.length) await applyLearn(ctx, { enrich: sug.enrich });
  return { enriched: sug.enrich.length };
}
