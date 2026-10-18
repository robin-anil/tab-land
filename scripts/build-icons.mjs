// Generates the Tab Land mark (SVG) and rasterizes the extension icons with Chromium.
// The mark: one solid browser tab (ink, favicon, title). Glow lives only in the tile background.
// Run: CHROMIUM_PATH=/path/to/chromium node scripts/build-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Open outline of a browser tab: flared feet, rounded shoulders. */
export function tab(x0, x1, yb, yt, r = 7, f = 6) {
  return `M${x0 - f} ${yb}Q${x0} ${yb} ${x0} ${yb - f}L${x0} ${yt + r}Q${x0} ${yt} ${x0 + r} ${yt}L${x1 - r} ${yt}Q${x1} ${yt} ${x1} ${yt + r}L${x1} ${yb - f}Q${x1} ${yb} ${x1 + f} ${yb}`;
}
export function tabFilled(x0, x1, yb, yt, r = 7, f = 6) {
  return `${tab(x0, x1, yb, yt, r, f)}Z`;
}

/** The mark: one browser tab in solid ink, with a Tab Blue favicon and a white title line. */
function mark() {
  return `
  <path d="M14 90Q24 90 24 80V50Q24 38 36 38H92Q104 38 104 50V80Q104 90 114 90Z" fill="#141829"/>
  <circle cx="44" cy="62" r="8" fill="#5E8BFF"/>
  <rect x="58" y="58" width="30" height="8" rx="4" fill="#FFFFFF"/>`;
}

/** Background only: white paper with blurred glow in the corners (butter, orchid, sky, lilac). */
function glow() {
  return `
  <rect width="128" height="128" fill="#FFFFFF"/>
  <g filter="url(#soft)" opacity=".55">
    <circle cx="14" cy="18" r="34" fill="#FFE08A"/>
    <circle cx="112" cy="14" r="36" fill="#F49BE6"/>
    <circle cx="20" cy="118" r="40" fill="#8AB4FF"/>
    <circle cx="112" cy="118" r="38" fill="#B9A4FF"/>
  </g>`;
}

function defs() {
  return `<defs>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
  <clipPath id="tile"><rect width="128" height="128" rx="30"/></clipPath></defs>`;
}

export function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${defs()}
  <g clip-path="url(#tile)">${glow()}${mark()}</g>
  <rect x=".75" y=".75" width="126.5" height="126.5" rx="29.5" fill="none" stroke="#141829" stroke-opacity=".07" stroke-width="1.5"/></svg>`;
}

const out = {
  'assets/icon.svg': iconSvg(),
  'src/ui/mark.svg': iconSvg(),
};
for (const [p, svg] of Object.entries(out)) fs.writeFileSync(path.join(root, p), svg.replace(/\n\s*/g, ''));

const { chromium } = await import('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128, 512]) {
  const svg = out['assets/icon.svg'];
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}">`);
  await page.waitForFunction(() => document.images[0].complete);
  const file = size === 512 ? 'assets/icon512.png' : `icons/icon${size}.png`;
  await page.screenshot({ path: path.join(root, file), omitBackground: true });
}
await browser.close();
console.log('icons written');
