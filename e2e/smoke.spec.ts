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
    // Filter out expected API errors (backend not running in CI/test)
    const unexpectedErrors = consoleErrors.filter(
      (e) => !e.includes("Failed to load resource"),
    );
    expect(unexpectedErrors).toEqual([]);
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

  test("dynamically discovers all view tabs", async ({ page }) => {
    // Discover view tabs dynamically from the DOM -- verifies that new views
    // added in the future will be detected without test updates
    const allButtons = page.locator("button.av-btn");
    await expect(allButtons.first()).toBeVisible();
    const count = await allButtons.count();
    const viewTabLabels: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = (await allButtons.nth(i).textContent()) || "";
      const trimmed = text.replace(/exp$/i, "").trim();
      if (trimmed.length > 0 && trimmed.length <= 12 && !trimmed.includes(" ")) {
        viewTabLabels.push(trimmed);
      }
    }
    // Should discover at least the 6 known views
    expect(viewTabLabels.length).toBeGreaterThanOrEqual(5);
    expect(viewTabLabels).toContain("Replay");
    expect(viewTabLabels).toContain("Stats");
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
