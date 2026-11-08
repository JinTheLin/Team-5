// Run with: node scripts/check-responsive.cjs [path-to-playwright] [base-url]
const { chromium } = require(process.argv[2] || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // Hardware is deliberately unavailable during layout verification.
  await page.route("http://172.20.10.3*/**", route => route.abort());
  const results = [];
  const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), "pocket-miracle-responsive-"));
  async function check(label) {
    // Measure settled controls, not a transformed frame during a sheet entrance
    // or press-release transition. Fractional CSS pixels can round below 44.
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const issues = await page.evaluate(() => {
      const problems = [];
      if (document.documentElement.scrollWidth > innerWidth) problems.push("page overflows horizontally");
      for (const selector of [".screen", ".sheet", ".home-emergency-sheet"]) {
        const el = document.querySelector(selector);
        if (el && el.scrollWidth > el.clientWidth + 1) problems.push(`${selector} overflows horizontally`);
      }
      const nav = document.querySelector(".tabbar").getBoundingClientRect();
      if (nav.bottom > innerHeight + 1) problems.push("navigation below viewport");
      for (const el of document.querySelectorAll("button:not(:disabled), input")) {
        if (el.classList.contains("scrim") || el.classList.contains("emergency-scrim")) continue;
        const target = el.matches('input[type="checkbox"],input[type="radio"]') ? el.closest("label") || el : el;
        const box = target.getBoundingClientRect();
        if (box.width && box.height && (box.width < 43.5 || box.height < 43.5)) problems.push(`small target: ${el.textContent || el.getAttribute("aria-label")}`);
      }
      return problems;
    });
    assert.deepEqual(issues, [], label);
  }
  try {
    for (const [width, height] of [[320,568],[360,640],[375,667],[390,844],[412,915],[430,932],[667,375],[844,390],[768,1024]]) {
      await page.setViewportSize({width,height});
      await page.goto(process.argv[3] || "http://localhost:8443");
      await require("./test-login.cjs")(page);
      await check("home");
      assert.equal(await page.locator(".statusbar,.homebar").count(), 0);
      await page.getByRole("button", {name:"Emergency help", exact:true}).click();
      await check("SOS");
      await page.getByRole("button", {name:"Preview SOS", exact:true}).click();
      await page.getByRole("button", {name:"Done", exact:true}).click();
      for (const name of ["Safety","Camera","Home"]) {
        await page.getByRole("navigation").getByRole("button", {name,exact:true}).click();
        await check(name);
      }
      await page.getByRole("button", {name:"Open settings"}).click();
      await check("settings");
      await page.getByRole("button", {name:/^Accessibility/}).click();
      await page.getByRole("switch", {name:"Larger text"}).click();
      await page.getByRole("switch", {name:"Reduce motion"}).click();
      await check("accessibility");
      await page.locator(".sheet-header").getByRole("button", {name:"Close settings",exact:true}).click();
      await page.getByRole("dialog", {name:"Settings",exact:true}).waitFor({state:"hidden"});
      await check("large text home");
      for (const name of ["Safety","Camera","Home"]) {
        await page.getByRole("navigation").getByRole("button", {name,exact:true}).click();
        await check(`large text ${name}`);
      }
      await page.screenshot({path:path.join(screenshots, `responsive-${width}x${height}.png`)});
      results.push(`${width}×${height}: passed`);
    }
    assert.deepEqual(errors, [], "uncaught application errors");
    console.log(results.join("\n"));
    console.log(`Screenshots: ${screenshots}`);
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
