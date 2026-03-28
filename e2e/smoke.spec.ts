import { test, expect, type Page } from "@playwright/test";

// Collect console errors during each test
const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
});

test.describe("Landing page", () => {
  test("loads without errors", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).toBeVisible();
    // The landing page should show the brand and file uploader
    await expect(page.getByText("AGENTVIZ", { exact: false })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("shows file upload area", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByText("load a demo session", { exact: false }),
    ).toBeVisible();
  });
});

test.describe("Demo session", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("load a demo session", { exact: false }).click();
    // Wait for session to load -- tabs should become visible
    await expect(page.getByRole("button", { name: /Replay/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("loads demo session and shows view tabs", async ({ page }) => {
    // All view tabs should be present
    await expect(
      page.getByRole("button", { name: /Replay/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tracks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Waterfall/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Stats/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Coach/i })).toBeVisible();
  });

  test("dynamically discovers and renders all view tabs without errors", async ({
    page,
  }) => {
    // Discover view tabs dynamically: these are the tab buttons whose text
    // matches known short labels (not toolbar actions like "Compare..." or "Filter...")
    const allButtons = page.locator("button.av-btn");
    const count = await allButtons.count();
    const viewTabs: { index: number; label: string }[] = [];
    for (let i = 0; i < count; i++) {
      const text = (await allButtons.nth(i).textContent()) || "";
      const trimmed = text.replace(/exp$/i, "").trim();
      // View tabs have short single-word labels (Replay, Tracks, etc.)
      if (trimmed.length > 0 && trimmed.length <= 12 && !trimmed.includes(" ")) {
        viewTabs.push({ index: i, label: trimmed });
      }
    }
    expect(viewTabs.length).toBeGreaterThanOrEqual(5);

    // Click each view tab and verify the page does not crash
    for (const { index } of viewTabs) {
      await allButtons.nth(index).click();
      await page.waitForTimeout(500);
      await expect(page.locator("#root")).toBeVisible();
    }

    expect(consoleErrors).toEqual([]);
  });

  test("replay view shows event content", async ({ page }) => {
    await page.getByRole("button", { name: /Replay/i }).click();
    // Replay view should have some event entries rendered
    await expect(page.locator("#root")).toBeVisible();
    // Search input should be visible in replay view
    await expect(page.locator("#agentviz-search")).toBeVisible();
  });

  test("stats view shows metrics", async ({ page }) => {
    await page.getByRole("button", { name: /Stats/i }).click();
    await page.waitForTimeout(500);
    await expect(page.locator("#root")).toBeVisible();
  });
});
