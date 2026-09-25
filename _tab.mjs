import { chromium } from "playwright";
const b = await chromium.launch();
// iPad 横向き（タブレット幅）
const ctx = await b.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3500);

const measure = async (label) => {
  const m = await p.evaluate(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return {w: Math.round(b.width), l: Math.round(b.left), r: Math.round(b.right)}; };
    const nav = document.querySelector('[data-cx="navbar"]');
    const aside = document.querySelector('[data-cx="aside"]');
    const main = document.querySelector('.mantine-AppShell-main');
    const col = main?.querySelector('div[style*="max-width"]');
    return {
      vw: window.innerWidth,
      navbar: nav ? r('[data-cx="navbar"]') : null,
      aside: aside ? r('[data-cx="aside"]') : null,
      main: main ? r('.mantine-AppShell-main') : null,
      col: col ? r('div[style*="max-width"]') : null,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
    };
  })()`);
  console.log(label, JSON.stringify(m));
};

await measure("100%:");
// 文字サイズ拡大（ブラウザのズーム相当 = root font-size を上げる）
for (const pct of [125, 150]) {
  await p.evaluate(`document.documentElement.style.fontSize = '${pct}%'`);
  await p.waitForTimeout(600);
  await measure(`${pct}%:`);
}
await b.close();
