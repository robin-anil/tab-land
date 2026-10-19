// End-to-end: loads the unpacked extension in Chromium against fake sites and a mock Jev server.
// Run: npm i -D playwright && npm run e2e   (set CHROMIUM_PATH to use a specific binary)
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS_DIR || path.join(root, 'tests', 'screenshots');
fs.mkdirSync(shots, { recursive: true });

// ---- fake websites (all *.test hosts resolve here) ----
const pages = {
  '/acme/api/pulls': '<h1>Pull requests</h1><a id="pr7" target="_blank" href="http://github.test/acme/api/pull/7">PR 7</a><a id="pr8" target="_blank" href="http://github.test/acme/api/pull/8">PR 8</a>',
  '/candidates': '<h1>Candidates</h1><a id="cand" target="_blank" href="http://linkedin.test/in/jane">Jane</a>',
};
const TITLES = {
  'linear.test/issue/ENG-482/billing-retry-fails': 'ENG-482 Billing retry fails for NJ claims',
  'github.test/acme/api/pull/91': 'Fix billing retry backoff (ENG-482) · Pull Request #91 · acme/api',
  'gdocs.test/document/d/runbook': 'Billing retry runbook - Google Docs',
  'github.test/acme/web/pull/5': 'Update marketing footer · Pull Request #5 · acme/web',
};
pages['/issue/ENG-482/billing-retry-fails'] = '<h1>ENG-482</h1><a id="pr" target="_blank" href="http://github.test/acme/api/pull/91">PR</a>';
const site = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const title = TITLES[`${req.headers.host}${p}`] || `${req.headers.host}${p}`;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${title}</title>${pages[p] || `<h1>${title}</h1>`}`);
});

// ---- mock Jev ----
const jevCalls = [];
const jev = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401, cors); return res.end('{"error":{"message":"bad key"}}'); }
  if (req.url === '/v1/models') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end('{"data":[{"id":"jev-latest"},{"id":"jev-preview"}]}'); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body);
    jevCalls.push(b);
    const answers = {};
    if (b.state && typeof b.state === 'object' && b.state.request) {
      // Ask routing: a tiny reader for the sentences the e2e steps type.
      const text = b.state.request;
      const names = Object.fromEntries(b.state.groups.map((l) => { const m = l.match(/^(g\d+): "([^"]*)"/); return [m[2].toLowerCase(), m[1]]; }));
      const g = (n) => names[(n || '').trim().toLowerCase()] || 'none';
      let m;
      const route = { action: 'none', destination: 'none', subject: 'none', name: null, merge: [], conf: 0.95 };
      if ((m = text.match(/^merge (.+) into (.+)$/i))) Object.assign(route, { action: 'merge', destination: g(m[2]), merge: [m[1].toLowerCase()] });
      else if ((m = text.match(/^rename (.+) to (.+)$/i))) Object.assign(route, { action: 'rename', subject: g(m[1]), name: m[2] });
      else if ((m = text.match(/^move .+ into (.+)$/i))) Object.assign(route, { action: 'move', destination: g(m[1]) === 'none' ? 'new' : g(m[1]), name: m[1], conf: 0.8 });
      for (const [q, spec] of Object.entries(b.questions)) {
        if (q === 'action') answers[q] = { choice: route.action, confidence: route.conf };
        else if (q === 'destination' || q === 'subject') answers[q] = { choice: route[q], confidence: route.conf };
        else if (q === 'new_name') answers[q] = { choice: Object.keys(spec.criteria).find((k) => spec.criteria[k] === `"${route.name}"`) || 'none', confidence: route.conf };
        else if (q.startsWith('merge_')) answers[q] = { noul: route.merge.some((n) => spec.instructions.toLowerCase().includes(`("${n}")`)) ? 0.9 : 0.05 };
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ model: 'jev-1.13.0', answers }));
    }
    const lines = b.state.split('\n');
    for (const [q, spec] of Object.entries(b.questions)) {
      if (spec.type === 'choice' && q === 'name') {
        const choice = Object.keys(spec.criteria).find((k) => spec.criteria[k].startsWith('Reading:')) || Object.keys(spec.criteria)[0];
        answers[q] = { type: 'choice', choice, confidence: 0.8, probabilities: { [choice]: 0.8 } };
      } else if (spec.type === 'choice') {
        const n = q.split('_')[1];
        const line = (lines.find((l) => l.startsWith(`[${n}]`)) || '').toLowerCase();
        const pick = (name) => Object.keys(spec.criteria).find((k) => spec.criteria[k].toLowerCase().startsWith(name.toLowerCase() + ':'));
        let choice = 'none';
        if (/ashby|linkedin/.test(line)) choice = pick('Hiring');
        else if (/github/.test(line)) choice = pick('Engineering');
        answers[q] = { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
      } else if (spec.type === 'noul') {
        answers[q] = { type: 'noul', noul: 0.92 };
      }
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json', 'x-typesafe-request-id': 'req_test' });
    res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 0 } }));
  });
});

await new Promise((r) => site.listen(8771, r));
await new Promise((r) => jev.listen(8772, r));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabland-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  colorScheme: 'light',
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  args: [
    `--disable-extensions-except=${root}`, `--load-extension=${root}`,
    '--host-resolver-rules=MAP *.test 127.0.0.1:8771',
  ],
});

let failures = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
};

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.chrome?.storage)); i++) await new Promise((r) => setTimeout(r, 100));

  // Configure: mock Jev, child tabs idle immediately.
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings || {}), jevApiKey: 'test-key', jevBaseUrl: 'http://127.0.0.1:8772', staleMinutes: 0, transientMinutes: 0, groupingMode: 'useCases' } });
  });
  for (const p of ctx.pages()) if (p.url().includes('options.html')) await p.close();

  const open = async (url) => { const p = await ctx.newPage(); await p.goto(url); return p; };
  const pulls = await open('http://github.test/acme/api/pulls');
  const [pr7] = await Promise.all([ctx.waitForEvent('page'), pulls.click('#pr7')]);
  await pr7.waitForLoadState();
  await pulls.bringToFront();
  const ats = await open('http://ashby.test/candidates');
  const [li] = await Promise.all([ctx.waitForEvent('page'), ats.click('#cand')]);
  await li.waitForLoadState();
  await open('http://docs.test/plan?utm_source=x');
  await open('http://docs.test/plan');
  await open('http://news.test/a');
  // Use the hiring tabs a lot so they rank first.
  for (let i = 0; i < 4; i++) { await ats.bringToFront(); await li.bringToFront(); }
  await ats.bringToFront();

  const ui = await ctx.newPage();
  await ui.setViewportSize({ width: 380, height: 590 });
  await ui.goto(`chrome-extension://${extId}/src/ui/popup.html`);
  const send = (msg) => ui.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const tabsNow = () => sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, index: t.index, groupId: t.groupId })));

  let plan;
  await step('plan finds the exact duplicate (tracking params ignored)', async () => {
    plan = await send({ type: 'plan' });
    assert.equal(plan.duplicates.length, 1, JSON.stringify(plan.duplicates));
    assert.match(plan.duplicates[0].close[0].url, /docs\.test\/plan/);
  });
  await step('plan finds opener children and Jev reviews them', async () => {
    const urls = plan.children.map((c) => c.tab.url);
    assert.ok(urls.some((u) => u.includes('/pull/7')), JSON.stringify(plan.children, null, 1));
    const pr = plan.children.find((c) => c.tab.url.includes('/pull/7'));
    assert.equal(pr.via, 'opener');
    assert.equal(pr.jev, 0.92);
    assert.ok(pr.confidence >= 0.9);
    assert.ok(jevCalls.some((b) => Object.values(b.questions).some((q) => q.type === 'noul')));
  });
  await step('nothing sent to Jev contains query strings', async () => {
    assert.ok(jevCalls.every((b) => !JSON.stringify(b.state).includes('utm_source')));
  });

  await ui.reload();
  await ui.waitForSelector('#dupList li');
  await ui.screenshot({ path: path.join(shots, 'popup.png') });

  await step('close selected duplicate + child, then undo restores them', async () => {
    const ids = [plan.duplicates[0].close[0].id, plan.children.find((c) => c.tab.url.includes('/pull/7')).tab.id];
    const before = (await tabsNow()).length;
    const r = await send({ type: 'close', tabIds: ids });
    assert.equal(r.closed, 2);
    assert.equal((await tabsNow()).length, before - 2);
    const u = await send({ type: 'undo' });
    assert.equal(u.reopened, 2);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await tabsNow()).length, before);
  });

  await step('group with Jev creates use-case groups', async () => {
    const r = await send({ type: 'group' });
    assert.equal(r.via, 'jev', JSON.stringify(r));
    const names = r.groups.map((g) => g.name);
    assert.ok(names.includes('Hiring'), names.join(','));
    assert.ok(names.includes('Engineering'), names.join(','));
    const groups = await sw.evaluate(() => chrome.tabGroups.query({}));
    const hiring = groups.find((g) => g.title === 'Hiring');
    assert.equal(hiring.color, 'yellow');
    const tabs = await tabsNow();
    const inHiring = tabs.filter((t) => t.groupId === hiring.id).map((t) => t.url);
    assert.ok(inHiring.some((u) => u.includes('ashby.test')) && inHiring.some((u) => u.includes('linkedin.test')));
  });

  await step('regrouping is stable (no duplicate groups)', async () => {
    await send({ type: 'group' });
    const groups = await sw.evaluate(() => chrome.tabGroups.query({}));
    assert.equal(groups.filter((g) => g.title === 'Hiring').length, 1);
  });

  const setSettings = (patch) => sw.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);
  await step('reorder puts the most-used group first, groups stay contiguous', async () => {
    await setSettings({ groupOrder: 'usage' });
    await send({ type: 'reorder' });
    const tabs = (await tabsNow()).sort((a, b) => a.index - b.index);
    const groups = await sw.evaluate(() => chrome.tabGroups.query({}));
    const hiring = groups.find((g) => g.title === 'Hiring');
    const firstWeb = tabs.find((t) => t.url.startsWith('http'));
    assert.equal(firstWeb.groupId, hiring.id, tabs.map((t) => t.url).join('\n'));
    for (const g of groups) {
      const idx = tabs.filter((t) => t.groupId === g.id).map((t) => t.index);
      assert.equal(Math.max(...idx) - Math.min(...idx) + 1, idx.length, `group ${g.title} not contiguous`);
    }
  });

  await step('recently used order: nothing moves while you read; the cycle puts the group you used last at the end', async () => {
    await setSettings({ groupOrder: 'recent', autoOrderGroups: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(await sw.evaluate(() => chrome.alarms.get('tab-land-order')), 'order alarm is set');
    const tabs = (await tabsNow()).sort((a, b) => a.index - b.index);
    const first = tabs.find((t) => t.groupId >= 0);
    await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), first.id);
    await new Promise((r) => setTimeout(r, 1500));
    let now = (await tabsNow()).sort((a, b) => a.index - b.index);
    assert.notEqual(now[now.length - 1].groupId, first.groupId, 'moved while reading');
    await send({ type: 'reorder' }); // what the 20-minute cycle runs
    now = (await tabsNow()).sort((a, b) => a.index - b.index);
    assert.equal(now[now.length - 1].id, first.id, 'the tab used last should end its group, at the end of the window');
  });

  await step('palette finds open tabs by title words and switches to them', async () => {
    const r = await send({ type: 'search', q: 'candidates' });
    assert.equal(r[0].kind, 'tab', JSON.stringify(r));
    assert.match(r[0].url, /ashby\.test\/candidates/);
    await send({ type: 'open', result: r[0] });
    const active = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);
    assert.match(active, /ashby\.test/);
  });

  await step('palette offers recently closed tabs and reopens them', async () => {
    const t = await ctx.newPage();
    await t.goto('http://closed.test/quarterly-report');
    await new Promise((r) => setTimeout(r, 300));
    await t.close();
    await new Promise((r) => setTimeout(r, 300));
    const r = await send({ type: 'search', q: 'quarterly' });
    const hit = r.find((x) => x.kind === 'closed');
    assert.ok(hit, JSON.stringify(r));
    await send({ type: 'open', result: hit });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok((await tabsNow()).some((x) => x.url.includes('closed.test/quarterly-report')));
  });

  await ui.goto(`chrome-extension://${extId}/src/ui/popup.html`);
  await ui.fill('#q', 'pull');
  await ui.waitForSelector('.res');
  await ui.screenshot({ path: path.join(shots, 'palette.png') });
  await ui.fill('#q', '');

  await step('park closes a group and saves it; resume restores it as a group in order', async () => {
    const groups = await sw.evaluate(() => chrome.tabGroups.query({ title: 'Hiring' }));
    const before = (await tabsNow()).filter((t) => t.groupId === groups[0].id).sort((a, b) => a.index - b.index).map((t) => t.url);
    const p = await send({ type: 'park', groupId: groups[0].id });
    assert.equal(p.parked, before.length);
    assert.ok(!(await tabsNow()).some((t) => before.includes(t.url)), 'group tabs closed');
    const c = await send({ type: 'contexts' });
    assert.equal(c.parked[0].name, 'Hiring');
    await ui.goto(`chrome-extension://${extId}/src/ui/popup.html`);
    await ui.click('button[data-view="contexts"]');
    await ui.waitForSelector('#parkedCtx li');
    await ui.screenshot({ path: path.join(shots, 'contexts.png') });
    const r = await send({ type: 'resume', id: c.parked[0].id });
    assert.equal(r.resumed, before.length);
    const g2 = (await sw.evaluate(() => chrome.tabGroups.query({ title: 'Hiring' })))[0];
    assert.ok(g2, 'group recreated');
    let after = [];
    for (let i = 0; i < 30; i++) {
      after = (await tabsNow()).filter((t) => t.groupId === g2.id).sort((a, b) => a.index - b.index).map((t) => t.url);
      if (after.every(Boolean) && after.length === before.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(after, before);
    assert.equal((await send({ type: 'contexts' })).parked.length, 0);
  });

  await step('learning: grouped tabs teach each use case its sites; co-used sites become a new use case named by Jev', async () => {
    const docs = ctx.pages().find((p) => p.url().includes('docs.test'));
    const news = ctx.pages().find((p) => p.url().includes('news.test'));
    for (let i = 0; i < 5; i++) { await docs.bringToFront(); await news.bringToFront(); }
    const s = await send({ type: 'learn' });
    const eng = s.enrich.find((e) => e.name === 'Engineering');
    assert.ok(eng && eng.sites.includes('github.test'), JSON.stringify(s.enrich));
    const add = s.add.find((a) => a.sites.includes('docs.test') && a.sites.includes('news.test'));
    assert.ok(add, JSON.stringify(s.add));
    assert.equal(add.name, 'Reading');
    assert.equal(add.via, 'jev');
    const r = await send({ type: 'applyLearn', changes: { add: [add], enrich: [eng], retire: [] } });
    const reading = r.useCases.find((u) => u.name === 'Reading');
    assert.ok(reading && reading.learned && reading.sites.includes('news.test'));
    assert.ok(r.useCases.find((u) => u.name === 'Engineering').sites.includes('github.test'));
    const naming = jevCalls.filter((b) => b.questions.name);
    assert.ok(naming.length && !Object.keys(naming[0].questions.name.criteria).some((k) => naming[0].questions.name.criteria[k].startsWith('Hiring:')), 'existing names are not offered');
  });

  await step('goal mode groups one incident across Linear, GitHub and Docs, not by site', async () => {
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, groupingMode: 'goals' } });
    });
    const issue = await open('http://linear.test/issue/ENG-482/billing-retry-fails');
    const [pr] = await Promise.all([ctx.waitForEvent('page'), issue.click('#pr')]);
    await pr.waitForLoadState();
    await open('http://gdocs.test/document/d/runbook');
    await open('http://github.test/acme/web/pull/5');
    const r = await send({ type: 'group' });
    assert.equal(r.mode, 'goals');
    const goal = r.goals.find((g) => g.name === 'ENG-482 Billing Retry');
    assert.ok(goal && goal.count === 3, JSON.stringify(r.goals));
    const groups = await sw.evaluate(() => chrome.tabGroups.query({ title: 'ENG-482 Billing Retry' }));
    const members = (await tabsNow()).filter((t) => t.groupId === groups[0].id).map((t) => new URL(t.url).host).sort();
    assert.deepEqual(members, ['gdocs.test', 'github.test', 'linear.test']);
    assert.ok(!(await tabsNow()).some((t) => t.url.includes('acme/web/pull/5') && t.groupId === groups[0].id));
    assert.ok(jevCalls.some((b) => b.questions.goal), 'Jev verified the goal');
  });

  await step('regroup everything rebuilds groups once, and undo puts them back', async () => {
    const snapshot = async () => {
      const groups = await sw.evaluate(() => chrome.tabGroups.query({}));
      const tabs = await tabsNow();
      return groups.map((g) => `${g.title}:${tabs.filter((t) => t.groupId === g.id).map((t) => t.url).sort().join(',')}`).sort();
    };
    const before = await snapshot();
    const r = await send({ type: 'regroup' });
    assert.ok(r.regrouped > 0 && r.canUndo, JSON.stringify(r));
    assert.ok((await send({ type: 'regroupState' })).canUndo);
    await ui.goto(`chrome-extension://${extId}/src/ui/popup.html`);
    await ui.click('#regroupBtn');
    await ui.waitForSelector('#regroupConfirm:not([hidden])');
    await ui.screenshot({ path: path.join(shots, 'regroup.png') });
    const u = await send({ type: 'undoRegroup' });
    assert.ok(u.restored > 0);
    assert.deepEqual(await snapshot(), before);
  });

  await step('Ask merges two groups from one sentence, and Undo puts them back', async () => {
    const ids = await sw.evaluate(async () => {
      for (const t of await chrome.tabs.query({})) if (t.groupId >= 0) await chrome.tabs.ungroup(t.id);
      const web = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url) && !t.pinned).map((t) => t.id);
      const a = await chrome.tabs.group({ tabIds: web.slice(0, 2) }); await chrome.tabGroups.update(a, { title: 'Growth' });
      const b = await chrome.tabs.group({ tabIds: web.slice(2, 4) }); await chrome.tabGroups.update(b, { title: 'Growth 2' });
      return { a, b };
    });
    await ui.goto(`chrome-extension://${extId}/src/ui/popup.html`);
    await ui.click('.seg.mode button[data-mode="ask"]');
    await ui.waitForSelector('#askMode:not([hidden])');
    await ui.waitForSelector('#lookAlikeSec:not([hidden])');
    await ui.fill('#askInput', 'Merge Growth 2 into Growth');
    await ui.press('#askInput', 'Enter');
    await ui.waitForSelector('.bot .ok');
    const groups = await sw.evaluate(() => chrome.tabGroups.query({}));
    assert.deepEqual(groups.map((g) => g.title), ['Growth']);
    assert.equal((await sw.evaluate((gid) => chrome.tabs.query({ groupId: gid }), ids.a)).length, 4);
    await ui.screenshot({ path: path.join(shots, 'ask.png') });
    await ui.click('#askUndo');
    await ui.waitForFunction(() => [...document.querySelectorAll('.bot')].some((b) => b.textContent.startsWith('Undone')));
    const after = (await sw.evaluate(() => chrome.tabGroups.query({}))).map((g) => g.title).sort();
    assert.deepEqual(after, ['Growth', 'Growth 2']);
    await ui.fill('#askInput', 'Rename Growth 2 to Paid growth');
    await ui.press('#askInput', 'Enter');
    await ui.waitForFunction(() => [...document.querySelectorAll('.bot')].some((b) => b.textContent.includes('Renamed Growth 2 to Paid growth')));
    const renamed = (await sw.evaluate(() => chrome.tabGroups.query({}))).map((g) => g.title).sort();
    assert.deepEqual(renamed, ['Growth', 'Paid growth']);
  });

  await step('Ask with a description shows the tabs to check before moving them', async () => {
    await ui.goto(`chrome-extension://${extId}/src/ui/popup.html`);
    await ui.click('.seg.mode button[data-mode="ask"]');
    await ui.fill('#askInput', 'Move the pull requests and docs into Review');
    await ui.press('#askInput', 'Enter');
    await ui.waitForSelector('.pv-go, .card .opts');
    await ui.screenshot({ path: path.join(shots, 'ask-check.png') });
    if (await ui.$('.card .opts')) for (const b of await ui.$$('.card .opts .btn:first-child')) await b.click();
    await ui.waitForSelector('.pv-go');
    const before = (await sw.evaluate(() => chrome.tabGroups.query({ title: 'Review' }))).length;
    assert.equal(before, 0, 'nothing moves before the check');
    await ui.click('.pv-go');
    await ui.waitForFunction(() => document.querySelectorAll('.bot .ok').length > 0);
    const g = await sw.evaluate(() => chrome.tabGroups.query({ title: 'Review' }));
    assert.equal(g.length, 1);
    await ui.click('#askUndo');
    await ui.waitForFunction(() => [...document.querySelectorAll('.bot')].some((b) => b.textContent.startsWith('Undone')));
  });

  await step('bad key surfaces an error and falls back to heuristics', async () => {
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, jevApiKey: 'wrong' } });
    });
    const r = await send({ type: 'group' });
    assert.equal(r.via, 'heuristic');
    assert.match(r.error || '', /401/);
    const t = await send({ type: 'testKey', settings: { jevApiKey: 'test-key', jevBaseUrl: 'http://127.0.0.1:8772' } });
    assert.deepEqual(t.models, ['jev-latest', 'jev-preview']);
  });

  const opt = await ctx.newPage();
  await opt.setViewportSize({ width: 900, height: 1400 });
  await opt.goto(`chrome-extension://${extId}/src/ui/options.html`);
  await opt.waitForSelector('.uc');
  await step('settings panel saves the Jev key', async () => {
    await opt.fill('#jevApiKey', 'test-key');
    await opt.fill('#jevBaseUrl', 'https://api.typesafe.ai'); // the mock URL would open a permission prompt headless can't answer
    await opt.click('#save');
    await opt.waitForFunction(() => document.getElementById('saveState').textContent === 'Saved');
    const s = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(s.jevApiKey, 'test-key');
    assert.ok(s.useCases.length >= 12);
  });
  await opt.click('#learnBtn');
  await opt.waitForSelector('#learnPanel:not([hidden])');
  await opt.screenshot({ path: path.join(shots, 'options.png'), fullPage: true });
  await ui.reload();
  await ui.waitForTimeout(400);
  await ui.screenshot({ path: path.join(shots, 'popup-after.png') });
} finally {
  await ctx.close();
  site.close();
  jev.close();
}
console.log(failures ? `\n${failures} failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
