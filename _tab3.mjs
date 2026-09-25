import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1024, height: 768 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3000);
for (const pct of [100, 150]) {
  await p.evaluate(pct===100 ? `document.documentElement.style.fontSize=''` : `document.documentElement.style.fontSize='${pct}%'`);
  await p.waitForTimeout(700);
  const m = await p.evaluate(`(() => {
    const main = document.querySelector('.mantine-AppShell-main');
    const col = main?.querySelector('div[style*="max-width"]');
    const cs = col ? getComputedStyle(col) : null;
    const mb = main.getBoundingClientRect();
    const cb = col.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      mainLeft: Math.round(mb.left), mainRight: Math.round(mb.right), mainW: Math.round(mb.width),
      mainPadL: cs ? getComputedStyle(main).paddingLeft : null,
      mainPadR: cs ? getComputedStyle(main).paddingRight : null,
      colLeft: Math.round(cb.left), colRight: Math.round(cb.right), colW: Math.round(cb.width),
      colPadL: cs?.paddingLeft, colPadR: cs?.paddingRight,
      colMaxW: cs?.maxWidth,
    };
  })()`);
  console.log(pct+"%:", JSON.stringify(m, null, 1));
}
await b.close();
