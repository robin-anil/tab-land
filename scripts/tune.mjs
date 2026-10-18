#!/usr/bin/env node
// Tune Tab Land's goal grouping on your real tabs, with Jev as the judge.
//
//   1. In Tab Land → Settings → "Export tabs for tuning" (saves tab-land-tuning.json to Downloads)
//   2. node scripts/tune.mjs [path/to/tab-land-tuning.json] [--env path/to/.env] [--full] [--no-jev] [--fresh]
//
// The Jev key is read from TYPESAFE_API_KEY (or TYPESAFE_AI_KEY / JEV_API_KEY / TYPESAFE_AI_API_KEY) in the .env file
// or the environment. Output is numbers only — no titles, no URLs — and is also written to
// .private/tuning-result.json (git-ignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tune, QUICK_GRID, FULL_GRID } from '../src/lib/tune.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a) => !a.startsWith('--') && a !== opt('--env')) || path.join(os.homedir(), 'Downloads', 'tab-land-tuning.json');

function readEnv(p) {
  try {
    return Object.fromEntries(fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l)).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
    }));
  } catch { return {}; }
}
const envFile = opt('--env') || [path.join(root, '.env'), path.join(process.cwd(), '.env')].find((p) => fs.existsSync(p));
const env = { ...(envFile ? readEnv(envFile) : {}), ...process.env };
const apiKey = flag('--no-jev') ? null : env.TYPESAFE_API_KEY || env.TYPESAFE_AI_KEY || env.JEV_API_KEY || env.TYPESAFE_AI_API_KEY || null;

if (!fs.existsSync(file)) { console.error(`No export at ${file}. Use Settings → "Export tabs for tuning" first.`); process.exit(1); }
const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
if (exp.kind !== 'tab-land-tuning') { console.error('That file is not a Tab Land tuning export.'); process.exit(1); }

console.log(`Tabs: ${exp.tabs.length}   Jev judge: ${apiKey ? 'on' : 'off'}${envFile && apiKey ? ` (key from ${path.basename(envFile)})` : ''}`);
const grid = flag('--full') ? FULL_GRID : QUICK_GRID;
// Jev's answers are cached (tab ids → numbers) so a stopped run picks up where it left off.
fs.mkdirSync(path.join(root, '.private'), { recursive: true });
const cacheFile = path.join(root, '.private', 'jev-cache.json');
let cache = { goals: {}, missed: {} };
try { if (!flag('--fresh')) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* start fresh */ }
const saveCache = () => fs.writeFileSync(cacheFile, JSON.stringify(cache));
const r = await tune(exp, { grid, apiKey, cache, onProgress: (i, n) => { saveCache(); process.stdout.write(`\r  tried ${i}/${n} settings`); } });
saveCache();
process.stdout.write('\n\n');

const pct = (x) => (x == null ? '   -  ' : `${(x * 100).toFixed(0).padStart(4)}%`);
const row = (label, x) => console.log(`${label.padEnd(26)} strict ${String(x.strict).padEnd(5)} attach ${String(x.attach).padEnd(5)} loose ${String(x.loose).padEnd(5)} | grouped ${pct(x.coverage)} (${x.grouped}/${x.tabs}) in ${String(x.groups).padStart(2)} groups, largest ${String(x.largest).padStart(2)} | Jev agrees ${pct(x.agreement)} | missed ${x.missed ?? '-'} | score ${x.score}`);
row('One strict pass', r.strictOnly);
row('Current settings', r.current);
row('Best', r.best);
console.log('\nTop 5:');
for (const x of r.results.slice(0, 5)) row('', x);
if (r.jev) console.log(`\nJev calls: ${r.jev.calls}, errors: ${r.jev.errors}${r.jev.errors ? ` (${Object.entries(r.jev.kinds || {}).map(([k, n]) => `${k}: ${n}`).join(', ')})` : ''}`);

const outFile = path.join(root, '.private', 'tuning-result.json');
fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2));
console.log(`\nSaved numbers to ${path.relative(process.cwd(), outFile)}`);
