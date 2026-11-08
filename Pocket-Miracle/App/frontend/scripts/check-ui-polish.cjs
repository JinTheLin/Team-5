// Isolated visual/interaction checks. All account and vision requests are mocked.
// node scripts/check-ui-polish.cjs [path-to-playwright] [base-url]
const { chromium } = require(process.argv[2] || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), "pocket-polish-"));
  page.on("pageerror", error => errors.push(error.message));
  const user = { id: "ui-preview-user", email: "preview@example.test", aud: "authenticated", user_metadata: {}, app_metadata: {} };
  let settings = { voice_enabled: true, volume: 50, large_text: false, reduce_motion: false, automatic_reconnect: true, warning_distance_cm: 150, warning_confidence: .75 };
  await context.route("https://*.supabase.co/**", async route => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname.endsWith("/token")) data = { user, access_token: "local-ui-fixture", refresh_token: "local-ui-fixture", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now()/1000) + 3600 };
    else if (url.pathname.endsWith("/user")) data = user;
    else if (url.pathname.endsWith("/app_settings")) {
      if (route.request().method() === "PATCH") settings = { ...settings, ...route.request().postDataJSON() };
      data = { id: "settings", ...settings };
    } else if (url.pathname.endsWith("/profiles")) data = { display_name: "Alex" };
    else if (url.pathname.endsWith("/detection_sessions")) data = [
      { id: "run-1", source_type: "webcam", started_at: "2026-11-07T15:00:00Z", ended_at: "2026-11-07T15:05:00Z", status: "stopped", simulated_distance_cm: 80 },
      { id: "run-2", source_type: "cane", started_at: "2026-11-06T14:00:00Z", ended_at: "2026-11-06T14:10:00Z", status: "stopped", simulated_distance_cm: null },
    ];
    else if (url.pathname.endsWith("/detection_events")) data = [{ id: "sighting", object_label: "chair", peak_confidence: .92, position: "ahead", first_seen_at: "2026-11-07T15:01:00Z" }];
    else if (url.pathname.endsWith("/warnings")) data = [{ id: "warning", message: "Chair ahead. Caution.", created_at: "2026-11-07T15:01:00Z", is_simulated: true, delivery_status: "local_only" }];
    await route.fulfill({ json: data });
  });
  await context.route("http://127.0.0.1:8765/**", route => route.fulfill({ json: { phase: "idle", detail: "Choose a camera to get started.", session_id: null, frame_id: 0, detections: [], last_warning: null } }));
  const base = process.argv[3] || "http://127.0.0.1:8443";
  async function settled() {
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  }
  async function layout(label) {
    await settled();
    const failures = await page.evaluate(() => {
      const issues = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("page overflows");
      for (const el of document.querySelectorAll(".screen,.sheet,.auth-card")) {
        if (el.scrollWidth > el.clientWidth + 1) issues.push(`${el.className} overflows`);
      }
      for (const el of document.querySelectorAll("button")) {
        if (el.closest("[inert]")) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) continue;
        if (rect.width < 43.5 || rect.height < 43.5) issues.push(`small control: ${el.textContent || el.getAttribute("aria-label")}`);
      }
      return issues;
    });
    assert.deepEqual(failures, [], label);
  }
  try {
    await page.goto(base);
    await page.locator(".auth-submit").waitFor();
    await layout("login");
    await page.screenshot({ path: path.join(screenshots, "login.png"), fullPage: true });
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await page.getByLabel("Your name").waitFor();
    await layout("signup");
    for (const [width, height] of [[320,568],[375,667],[844,390]]) {
      await page.setViewportSize({ width, height });
      await layout(`signup ${width}`);
    }
    await page.setViewportSize({ width:390, height:844 });
    await page.getByRole("button", { name: "Log in", exact: true }).first().click();
    await page.getByLabel("Email address", { exact: true }).fill(user.email);
    await page.getByLabel(/^Password/).fill("local-ui-fixture");
    await page.locator(".auth-submit").click();
    await page.getByRole("navigation").waitFor();
    for (const [width, height] of [[320,568],[375,667],[390,844],[430,932],[844,390],[768,1024]]) {
      await page.setViewportSize({ width, height });
      for (const name of ["Home", "Safety", "Camera", "History"]) {
        await page.getByRole("navigation").getByRole("button", { name, exact:true }).click();
        await layout(`${name} ${width}x${height}`);
        if (name === "History") {
          const row = page.locator(".run-heading").first();
          await row.waitFor();
          await row.click();
          await page.getByText("Object sightings", { exact:true }).waitFor();
          await layout(`expanded history ${width}`);
          await row.click();
          await settled();
          assert.equal(await page.locator(".run-details").count(), 0);
        }
        if (width === 390) await page.screenshot({ path: path.join(screenshots, `${name.toLowerCase()}.png`) });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("navigation").getByRole("button", { name: "Home", exact: true }).click();
    await page.getByRole("button", { name: "Open settings" }).click();
    await layout("settings");
    await page.screenshot({ path: path.join(screenshots, "settings.png") });
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest(".sheet"))), true);
    await page.keyboard.press("Escape");
    await settled();
    assert.equal(await page.getByRole("dialog", { name: "Settings" }).count(), 0);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "Accessibility Text size, motion, screen readers" }).click();
    await page.getByRole("switch", { name: "Larger text" }).click();
    await layout("larger text settings");
    await page.getByRole("switch", { name: "Reduce motion" }).click();
    await page.keyboard.press("Escape");
    await settled();
    await page.getByRole("navigation").getByRole("button", { name:"History", exact:true }).click();
    await layout("larger text history");
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0, "app reduced motion");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => document.querySelector(".phone").classList.remove("reduce-motion"));
    await page.getByRole("navigation").getByRole("button", { name:"Camera", exact:true }).click();
    await layout("OS reduced motion");
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0, "OS reduced motion");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed:true, viewportSizes:6, checks:"login/signup, all tabs, history expansion, touch targets, settings focus/Escape, larger text, reduced motion", screenshots }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
