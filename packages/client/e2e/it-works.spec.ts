import { expect, test } from "@playwright/test";

// Both assertions here were left behind by the Stoat → Sloga rename: the
// document title is "Sloga", and the old "Sign into Stoat" heading no longer
// exists anywhere in the client. Assert on copy the login flow actually
// renders, so this keeps testing "the login form came up" rather than a
// brand string that can be renamed again.
test("shows a working login page", async ({ page }) => {
  await page.goto("");
  await expect(page).toHaveTitle(/Sloga/);

  const login = page.getByRole("button", { name: "Log In" });
  await expect(login).toBeVisible();
  await login.click();

  await expect(page.getByText(/Keep me logged in/)).toBeVisible();
});
