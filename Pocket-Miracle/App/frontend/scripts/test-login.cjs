module.exports = async function loginIfNeeded(page) {
  await page.waitForFunction(() => document.querySelector('nav[aria-label="Primary navigation"], .auth-submit'));
  if (await page.locator(".auth-submit").count()) {
    const user = JSON.parse(process.env.PM_TEST_USERS_JSON || "[]")[0];
    if (!user) throw new Error("Provide a test account through PM_TEST_USERS_JSON to test authenticated screens.");
    await page.getByLabel("Email address", {exact:true}).fill(user.email);
    await page.getByLabel(/^Password/).fill(user.password);
    await page.locator(".auth-submit").click();
  }
  await page.getByRole("navigation", {name:"Primary navigation"}).waitFor();
};
