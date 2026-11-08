// Browser UI integration with mock API responses; never opens a real webcam.
const { chromium } = require(process.argv[2] || "playwright");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({viewport:{width:390,height:844}});
  let state = {phase:"idle",detail:"Ready",session_id:null,frame_id:0,detections:[],last_warning:null};
  let lastStart;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://127.0.0.1:8765/**", async route => {
    const url = route.request().url();
    if (url.includes("/api/start")) {
      lastStart = route.request().postDataJSON();
      state = {phase:"live",detail:"Chair ahead",session_id:"test",frame_id:1,mode:lastStart.mode,
        simulated:lastStart.simulated_cm !== null,sonar_cm:lastStart.simulated_cm,sonar_fresh:true,inference_ms:12,
        detections:[{name:"chair",confidence:.95,ahead:true,eligible:true}],
        last_warning:{message:"Chair, less than one meter. Caution.",at:Date.now()/1000,simulated:true}};
    }
    if (url.includes("/api/stop")) state = {...state,phase:"stopped",detections:[]};
    if (url.includes("/api/frame.jpg")) return route.fulfill({status:200,contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#17172b"/></svg>'});
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(state)});
  });
  try {
    await page.goto(process.argv[3] || "http://localhost:8443");
    await require("./test-login.cjs")(page);
    await page.getByRole("navigation").getByRole("button", {name:"Camera",exact:true}).click();
    await page.getByLabel("Laptop webcam",{exact:true}).check();
    await page.getByLabel("Simulate distance to test warning rules").check();
    await page.getByRole("button",{name:"Start webcam test",exact:true}).click();
    await page.getByText("chair",{exact:true}).waitFor();
    assert.equal(lastStart.mode,"webcam");
    assert.equal(lastStart.simulated_cm,80);
    assert.equal(lastStart.send_warnings,false);
    await page.getByText("Chair, less than one meter. Caution.",{exact:true}).waitFor();
    for (const [width,height] of [[320,568],[390,844],[844,390]]) {
      await page.setViewportSize({width,height});
      assert.equal(await page.locator(".screen").evaluate(el => el.scrollWidth > el.clientWidth),false);
    }
    await page.getByRole("button",{name:"Stop detection",exact:true}).click();
    await page.getByRole("button",{name:"Start webcam test",exact:true}).waitFor();
    await page.unroute("http://127.0.0.1:8765/**");
    await page.route("http://127.0.0.1:8765/**",route=>route.abort());
    await page.getByText("Laptop service offline",{exact:true}).first().waitFor();
    assert.equal(await page.getByRole("button",{name:"Start webcam test",exact:true}).isDisabled(),true);
    assert.deepEqual(errors,[]);
    console.log("Vision UI: start config, real-result rendering, warning display, stop, service loss, and 3 viewport sizes passed (mock API).");
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
