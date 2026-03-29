import { test, expect } from "@playwright/test";

// FAX-VIZ E2E tests
// These require the fax-viz dev server to be running on port 3001
// with the fax-viz-server backend on port 4243.
//
// Since the Playwright config targets port 3000 (main AGENTVIZ),
// these tests navigate directly to the fax-viz dev URL.

var FAX_VIZ_URL = "http://localhost:3001/fax-viz-index.html";

test.describe("FAX-VIZ landing", () => {
  test("loads without crashes", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(FAX_VIZ_URL, {
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
    await page.goto(FAX_VIZ_URL);
    // Wait for faxes to load
    await page.waitForTimeout(2000);

    // Toolbar elements should be visible
    await expect(
      page.getByPlaceholder("Search faxes..."),
    ).toBeVisible();
    await expect(page.getByText("Refresh", { exact: false })).toBeVisible();
  });
});

test.describe("FAX-VIZ Pick Up flow", () => {
  test("Pick Up button is visible when faxes are listed", async ({ page }) => {
    await page.goto(FAX_VIZ_URL);
    await page.waitForTimeout(2000);

    // If there are fax cards in the inbox, each should have a Pick Up button
    var faxCards = page.locator('[data-testid="fax-card"]');
    var count = await faxCards.count();

    // Skip if no faxes are available (server may not have a fax dir configured)
    test.skip(count === 0, "No fax bundles available to test Pick Up button");

    var pickUpButton = faxCards.first().getByText("Pick Up", { exact: false });
    await expect(pickUpButton).toBeVisible();
  });

  test("Pick Up modal opens and closes with Escape", async ({ page }) => {
    await page.goto(FAX_VIZ_URL);
    await page.waitForTimeout(2000);

    var faxCards = page.locator('[data-testid="fax-card"]');
    var count = await faxCards.count();
    test.skip(count === 0, "No fax bundles available to test Pick Up modal");

    // Click the Pick Up button on the first fax card
    var pickUpButton = faxCards.first().getByText("Pick Up", { exact: false });
    await pickUpButton.click();

    // Modal should appear with tool selector and New/Resume options
    var modal = page.locator('[data-testid="pickup-modal"]');
    await expect(modal).toBeVisible({ timeout: 3000 });

    // Verify modal contains expected controls
    await expect(modal.getByText("New", { exact: false })).toBeVisible();
    await expect(modal.getByText("Resume", { exact: false })).toBeVisible();

    // Close modal with Escape
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible({ timeout: 2000 });
  });
});
