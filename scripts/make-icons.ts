// Makes every icon from web/icon.svg (F34, a ball of thread): the iPhone's touch icon
// (web/apple-touch-icon.png, 180 px: iOS ignores SVG touch icons) and the app icons in
// ios/Assets.xcassets (1024 px, light, dark and tinted). App and touch icons are square, since
// iOS rounds the corners itself. The Mac's icons (16 to 1024 px) are drawn on Apple's Mac grid,
// the rounded square inset with a soft shadow, since macOS shows the picture as it is; without
// them the Mac app has no icon. Needs rsvg-convert (`brew install librsvg`).
// Run: bun scripts/make-icons.ts

import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const light = (await Bun.file(`${root}web/icon.svg`).text()).replace('rx="14" ', "");
// Dark: the thread on a dark ground. Tinted: shades of grey, which iOS colours.
const dark = light
  .replace('stop-color="#2e5597"', 'stop-color="#1a2438"')
  .replace('stop-color="#122a52"', 'stop-color="#0b111d"')
  .replace('<circle cx="32" cy="27" r="15" fill="#fff"/>', '<circle cx="32" cy="27" r="15" fill="#dde6f5"/>')
  .replace('stroke="#1d3d73"', 'stroke="#3f6ab0"');
const tinted = light
  .replace('stop-color="#2e5597"', 'stop-color="#000"')
  .replace('stop-color="#122a52"', 'stop-color="#000"')
  .replace('stroke="#1d3d73"', 'stroke="#000"')
  .replace('fill="#f6c453"', 'fill="#aaa"');

async function png(svg: string, size: number, out: string) {
  const tmp = `${out}.svg`;
  await Bun.write(tmp, svg);
  await $`rsvg-convert -w ${size} -h ${size} ${tmp} -o ${out}`;
  await $`rm ${tmp}`;
  console.log(`wrote ${out.replace(root, "")}`);
}

const set = `${root}ios/Assets.xcassets/AppIcon.appiconset`;
await png(light, 180, `${root}web/apple-touch-icon.png`);
await png(light, 1024, `${set}/icon-1024.png`);
await png(dark, 1024, `${set}/icon-1024-dark.png`);
await png(tinted, 1024, `${set}/icon-1024-tinted.png`);

// The Mac: the rounded square at 824 of 1024, centred, with a soft shadow (Apple's Mac icon grid).
const body = (await Bun.file(`${root}web/icon.svg`).text()).replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const mac = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feGaussianBlur in="SourceAlpha" stdDeviation="10"/><feOffset dy="10"/><feComponentTransfer><feFuncA type="linear" slope="0.3"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g filter="url(#shadow)"><g transform="translate(100 100) scale(12.875)">${body}</g></g></svg>`;
for (const size of [16, 32, 64, 128, 256, 512, 1024]) await png(mac, size, `${set}/mac-${size}.png`);
