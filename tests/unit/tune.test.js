// The tuner: runs configs on an export, uses Jev as judge, and never leaks titles or URLs.
import { test, expect } from 'vitest';
import { WORKDAY } from '../fixtures/workday.js';
import { tune, prepare, evaluate } from '../../src/lib/tune.js';
import { DEFAULTS } from '../../src/lib/settings.js';
import { mockJev } from './harness.js';

const exp = { kind: 'tab-land-tuning', version: 1, exportedAt: Date.now(), settings: { ...DEFAULTS, aiExcludedDomains: ['ads.google.com'] }, useCases: DEFAULTS.useCases, tabs: WORKDAY.map((x) => x.tab), tabPairs: {}, urlLineage: {} };

test('without Jev it reports coverage per config, and iterative beats one strict pass', async () => {
  const r = await tune(exp);
  expect(r.tabs).toBe(27);
  expect(r.current.coverage).toBeGreaterThan(r.strictOnly.coverage);
  expect(r.results.length).toBe(9);
  expect(r.best.score).toBeGreaterThanOrEqual(r.results.at(-1).score);
});

test('with Jev it judges groups and loose tabs, caches repeat goals, and respects excluded domains', async () => {
  const { fetchImpl, calls } = mockJev((body) => {
    const answers = {};
    for (const [q, spec] of Object.entries(body.questions)) {
      if (spec.type === 'noul') answers[q] = { noul: 0.8 };
      else { const k = Object.keys(spec.criteria).find((x) => x.startsWith('g')) || 'none'; answers[q] = { choice: k, confidence: 0.7 }; }
    }
    return { answers };
  });
  const r = await tune(exp, { apiKey: 'k', fetchImpl, retryDelay: 1 });
  expect(r.current.agreement).toBeCloseTo(0.8, 5);
  expect(r.current.missed).toBeGreaterThan(0);
  const sentStates = calls.map((c) => c.body.state).join('\n');
  expect(sentStates).not.toContain('Google Ads'); // excluded domain never sent
  const goalCalls = calls.filter((c) => c.body.questions.goal).length;
  expect(goalCalls).toBeLessThan(11 * 6); // cached: far fewer than configs × goals
});

test('results are numbers only: no titles or URLs anywhere', async () => {
  const r = await tune(exp);
  const text = JSON.stringify(r);
  for (const { tab } of WORKDAY) { expect(text).not.toContain(tab.title); expect(text).not.toContain(tab.url); }
});

test('evaluate splits coverage by pass', async () => {
  const prep = prepare(exp);
  const e = await evaluate(prep, { strict: 0.3, attach: 0.15, loose: 0.18 });
  expect(Object.keys(e.byPass).length).toBeGreaterThan(0);
  expect(e.grouped).toBe(Object.values(e.byPass).reduce((a, b) => a + b, 0));
});

test('a saved Jev cache lets a second run finish without calling Jev again, and holds only ids and numbers', async () => {
  const { fetchImpl, calls } = mockJev((body) => {
    const answers = {};
    for (const [q, spec] of Object.entries(body.questions)) answers[q] = spec.type === 'noul' ? { noul: 0.7 } : { choice: 'none', confidence: 0.9 };
    return { answers };
  });
  const cache = { goals: {}, missed: {} };
  const first = await tune(exp, { apiKey: 'k', fetchImpl, retryDelay: 1, cache });
  const used = calls.length;
  expect(used).toBeGreaterThan(0);
  const saved = JSON.parse(JSON.stringify(cache));
  const second = await tune(exp, { apiKey: 'k', fetchImpl, retryDelay: 1, cache: saved });
  expect(calls.length).toBe(used);
  expect(second.best).toEqual(first.best);
  const text = JSON.stringify(saved);
  for (const { tab } of WORKDAY) { expect(text).not.toContain(tab.url); if (tab.title) expect(text).not.toContain(tab.title); }
});
