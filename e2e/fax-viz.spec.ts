import { test, expect } from "@playwright/test";

// FAX-VIZ E2E tests
// These require the fax-viz dev server to be running on port 3001
// with the fax-viz-server backend on port 4243.
//
// Since the Playwright config targets port 3000 (main AGENTVIZ),
// these tests navigate directly to the fax-viz dev URL.

test.describe("FAX-VIZ landing", () => {
  test("loads without crashes", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("http://localhost:3001/fax-viz-index.html", {
      timeout: 10_000,
    });
    await expect(page.locator("#root")).toBeVisible();
    await expect(page.getByText("FAX-VIZ")).toBeVisible();

    // Wait for async effects to settle
    await page.waitForLoadState("networkidle");

    const unexpectedErrors = consoleErrors.filter(
      (e) =>
        !e.includes("Failed to load resource") &&
        !e.includes("favicon"),
    );
    expect(unexpectedErrors).toEqual([]);
  });

  test("shows inbox with toolbar", async ({ page }) => {
    await page.goto("http://localhost:3001/fax-viz-index.html");
    // Wait for faxes to load
    await page.waitForTimeout(2000);

    // Toolbar elements should be visible
    await expect(
      page.getByPlaceholder("Search faxes..."),
    ).toBeVisible();
    await expect(page.getByText("Refresh", { exact: false })).toBeVisible();
  });
});
