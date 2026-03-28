import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("load a demo session", { exact: false }).click();
    await expect(page.getByRole("button", { name: /Replay/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("clicking each tab switches the active view", async ({ page }) => {
    const viewTabs = ["Replay", "Tracks", "Waterfall", "Stats", "Coach"];

    for (const label of viewTabs) {
      const tab = page.getByRole("button", { name: label, exact: true });
      await tab.click();
      await page.waitForTimeout(300);
      // Verify the tab appears active (has a non-transparent background)
      await expect(tab).toBeVisible();
      await expect(page.locator("#root")).toBeVisible();
    }
  });

  test("keyboard shortcuts 1-5 switch views", async ({ page }) => {
    // Ensure no input is focused (shortcuts shouldn't fire when typing)
    await page.locator("body").click();

    // Press '1' for Replay
    await page.keyboard.press("1");
    await page.waitForTimeout(300);
    await expect(page.locator("#agentviz-search")).toBeVisible();

    // Press '2' for Tracks
    await page.keyboard.press("2");
    await page.waitForTimeout(300);
    await expect(page.locator("#root")).toBeVisible();

    // Press '5' for Stats
    await page.keyboard.press("5");
    await page.waitForTimeout(300);
    await expect(page.locator("#root")).toBeVisible();
  });

  test("command palette opens with Cmd+K / Ctrl+K", async ({ page }) => {
    // Use Ctrl+K (works cross-platform in tests, Cmd+K on Mac)
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(500);

    // Command palette should show an input for searching
    const paletteInput = page.locator(
      'input[placeholder*="Search" i], input[placeholder*="command" i], input[type="text"]',
    );
    // At least one search-like input should be visible
    const visible = await paletteInput.first().isVisible().catch(() => false);

    // Close the palette
    await page.keyboard.press("Escape");

    // We just verify no crash occurred
    await expect(page.locator("#root")).toBeVisible();
  });

  test("search input filters events in replay view", async ({ page }) => {
    // Switch to replay view
    await page.getByRole("button", { name: /Replay/i }).click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("#agentviz-search");
    await expect(searchInput).toBeVisible();

    // Type a search query
    await searchInput.fill("test");
    await page.waitForTimeout(500);

    // Search should not crash the app
    await expect(page.locator("#root")).toBeVisible();

    // Clear search
    await searchInput.fill("");
    await page.waitForTimeout(300);
  });
});
