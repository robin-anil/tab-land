// Test harness: a real app instance wired to the fake chrome, a mock Jev, and a controllable clock.
import { createFakeChrome } from '../fakes/chrome.js';
import { createApp } from '../../src/bg/app.js';

export const MIN = 60e3;

/**
 * jev(body) returns answers for a System One request, or a Response-like {status, body} to simulate errors.
 * Default: picks the first criteria key for choices, 0.9 for noul questions.
 */
export function mockJev(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (init.signal?.aborted) throw new Error('aborted');
    const out = await handler(calls.at(-1).body, { url, init, calls });
    if (out && out.__raw) return out.__raw;
    if (out && typeof out.status === 'number') return new Response(JSON.stringify(out.body ?? {}), { status: out.status });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'x-typesafe-request-id': 'req_test' } });
  };
  return { fetchImpl, calls };
}

export function defaultJev(body) {
  if (!body) return { data: [{ id: 'jev-latest' }] };
  const answers = {};
  for (const [q, spec] of Object.entries(body.questions || {})) {
    if (spec.type === 'choice') { const k = Object.keys(spec.criteria)[0]; answers[q] = { type: 'choice', choice: k, confidence: 0.9 }; }
    else answers[q] = { type: 'noul', noul: 0.9 };
  }
  return { model: 'jev-1.13.0', answers };
}

export async function harness({ jev = defaultJev, settings = {}, start = Date.UTC(2026, 9, 18, 16) } = {}) {
  let t = start;
  const clock = { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
  const fake = createFakeChrome({ now: clock.now });
  const { fetchImpl, calls } = mockJev(jev);
  const logs = [];
  const app = createApp({
    chrome: fake.chrome, fetch: fetchImpl, now: clock.now, saveDelayMs: 0,
    uuid: (() => { let n = 0; return () => `uuid-${++n}`; })(),
    console: { warn: (m) => logs.push(m) },
  });
  app.ctx.jevRetryDelay = 1;
  await fake.chrome.storage.local.set({ settings: { jevApiKey: 'test-key', staleMinutes: 30, ...settings } });
  app.attach();
  await app.ctx.ready();
  const send = (msg, sender) => fake.chrome.runtime.sendMessage(msg, sender);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { fake, app, ctx: app.ctx, chrome: fake.chrome, send, clock, jevCalls: calls, logs, settle };
}
