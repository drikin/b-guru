import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3000);
const m = await p.evaluate(`(() => {
  const main = document.querySelector('.mantine-AppShell-main');
  const col = main?.querySelector('div[style*="max-width"]');
  const cs = getComputedStyle(main);
  const ccs = getComputedStyle(col);
  const mb = main.getBoundingClientRect();
  const cb = col.getBoundingClientRect();
  return {
    vw: window.innerWidth,
    shellM: getComputedStyle(document.querySelector('.appshell-center')).getPropertyValue('--shell-m'),
    mainW: Math.round(mb.width), mainPadL: cs.paddingLeft, mainPadR: cs.paddingRight,
    avail: Math.round(mb.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
    colW: Math.round(cb.width), colMaxW: ccs.maxWidth,
    colPadL: ccs.paddingLeft, colPadR: ccs.paddingRight,
    colContentW: Math.round(cb.width - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight)),
  };
})()`);
console.log(JSON.stringify(m, null, 1));
await b.close();
