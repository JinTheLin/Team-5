// Real Supabase login/preferences/history checks using disposable test users.
const { chromium } = require(process.argv[2] || "playwright");
const assert = require("node:assert/strict");
const config = require("../src/supabase-config.json");
const path = require("node:path");
const os = require("node:os");
const users = JSON.parse(process.env.PM_TEST_USERS_JSON || "[]");

(async () => {
  assert.equal(users.length,2,"Provide two disposable accounts via PM_TEST_USERS_JSON");
  const browser = await chromium.launch({channel:"msedge",headless:true});
  const context = await browser.newContext({viewport:{width:390,height:844}});
  const page = await context.newPage();
  const errors = [];
  const preferenceWrites = [];
  page.on("request", request => { if(request.method()==="PATCH" && request.url().includes("/app_settings")) preferenceWrites.push(request.postDataJSON()); });
  page.on("pageerror",error=>errors.push(error.message));
  async function login(user) {
    await page.getByLabel("Email address",{exact:true}).fill(user.email);
    await page.getByLabel(/^Password/).fill(user.password);
    await page.locator(".auth-submit").click();
    await page.getByRole("navigation",{name:"Primary navigation"}).waitFor();
  }
  async function accountToken() {
    return page.evaluate(() => {
      const key = Object.keys(localStorage).find(key=>/^sb-.*-auth-token$/.test(key));
      return key ? JSON.parse(localStorage.getItem(key)).access_token : null;
    });
  }
  try {
    await page.goto(process.argv[3] || "http://localhost:8443");
    await page.locator(".auth-submit").waitFor();
    assert.equal(await page.getByRole("navigation").count(),0);
    await page.getByRole("button",{name:"Sign up",exact:true}).click();
    await page.getByLabel("Your name",{exact:true}).fill("New user");
    for(const [width,height] of [[320,568],[375,667],[390,844],[844,390]]) {
      await page.setViewportSize({width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(os.tmpdir(),"pocket-miracle-signup.png")});
    // Verify the confirmation-required branch without sending an email.
    await page.route("**/auth/v1/signup*",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:users[0].id,aud:"authenticated",role:"authenticated",email:"confirmation@example.test",identities:[],created_at:new Date().toISOString()})}));
    await page.getByLabel("Email address",{exact:true}).fill("confirmation@example.test");
    await page.getByLabel(/^Password/).fill("Test-confirmation-123!");
    await page.locator(".auth-submit").click();
    await page.getByRole("status").filter({hasText:"Check your email"}).waitFor();
    assert.equal(await page.getByRole("navigation").count(),0);
    await page.unroute("**/auth/v1/signup*");
    await page.getByRole("button",{name:"Log in",exact:true}).first().click();
    await page.getByLabel("Email address",{exact:true}).fill(users[0].email);
    await page.getByLabel(/^Password/).fill("deliberately-wrong-password");
    await page.locator(".auth-submit").click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("navigation").count(),0);
    await login(users[0]);
    await page.getByRole("button",{name:"Open settings"}).click();
    await page.getByRole("button",{name:/^Accessibility/}).click();
    const savedResponse = page.waitForResponse(response => response.url().includes("/rest/v1/app_settings") && response.request().method()==="PATCH" && response.ok());
    await page.getByRole("switch",{name:"Larger text"}).click();
    await page.getByRole("button",{name:"Back",exact:true}).click();
    await savedResponse;
    await page.getByText("Preferences saved to your account",{exact:true}).waitFor();
    const tokenA = await accountToken();
    const persisted = await fetch(config.url+"/rest/v1/app_settings?select=large_text",{headers:{apikey:config.publishableKey,Authorization:"Bearer "+tokenA}});
    assert.equal((await persisted.json())[0].large_text,true);
    await page.reload();
    await page.getByRole("navigation",{name:"Primary navigation"}).waitFor();
    await page.locator(".phone.large-text").waitFor();
    await page.getByRole("navigation").getByRole("button",{name:"History",exact:true}).click();
    await page.locator(".run-heading").first().click();
    await page.locator(".history-event").filter({hasText:"chair"}).waitFor();
    await page.getByText("Chair, less than one meter. Caution.",{exact:true}).waitFor();
    await page.getByRole("navigation").getByRole("button",{name:"Home",exact:true}).click();
    await page.getByRole("button",{name:"Open settings"}).click();
    await page.getByRole("button",{name:"Log out",exact:true}).click();
    await page.locator(".auth-submit").waitFor();
    assert.equal(await page.getByRole("navigation").count(),0);
    await login(users[1]);
    assert.equal(await page.locator(".phone.large-text").count(),0);
    const tokenB = await accountToken();
    const foreign = await fetch(config.url+"/rest/v1/app_settings?user_id=eq."+users[0].id,{headers:{apikey:config.publishableKey,Authorization:"Bearer "+tokenB}});
    assert.deepEqual(await foreign.json(),[]);
    await page.getByRole("navigation").getByRole("button",{name:"History",exact:true}).click();
    await page.locator(".run-heading").first().waitFor();
    assert.equal(await page.locator(".run-heading").count(),1);
    assert.deepEqual(errors,[]);
    await page.getByRole("navigation").getByRole("button",{name:"Home",exact:true}).click();
    await page.getByRole("button",{name:"Open settings"}).click();
    await page.getByRole("button",{name:"Log out",exact:true}).click();
    await page.locator(".auth-submit").waitFor();
    console.log("Auth passed: welcome/signup layout, confirmation-required UI (mock email), real login, preference persistence/reload, saved history, logout, and two-account isolation.");
  } catch(error) { console.error("Preference write sequence:",JSON.stringify(preferenceWrites));await page.screenshot({path:path.join(os.tmpdir(),"pocket-miracle-auth-failure.png")});throw error; }
  finally { await context.close();await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
