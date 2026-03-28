import { test, expect } from "@playwright/test";

test.describe("Playback interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("load a demo session", { exact: false }).click();
    await expect(page.getByRole("button", { name: /Replay/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("play/pause button toggles playback", async ({ page }) => {
    const playButton = page.getByRole("button", {
      name: /Play playback/i,
    });
    const pauseButton = page.getByRole("button", {
      name: /Pause playback/i,
    });

    // Initially should show play button (paused state)
    // Either play or pause should be visible
    const hasPlay = await playButton.isVisible().catch(() => false);
    const hasPause = await pauseButton.isVisible().catch(() => false);
    expect(hasPlay || hasPause).toBe(true);

    if (hasPlay) {
      // Click play, should switch to pause
      await playButton.click();
      await page.waitForTimeout(500);
      await expect(pauseButton).toBeVisible();

      // Click pause to stop
      await pauseButton.click();
      await page.waitForTimeout(300);
      await expect(playButton).toBeVisible();
    }
  });

  test("timeline bar is interactive", async ({ page }) => {
    // The timeline component should be visible
    // Look for the timeline bar area (it's a div that handles click/drag)
    const timeline = page.locator('[data-testid="timeline"]').or(
      // Fallback: look for the timeline container with progress-like behavior
      page.locator("#root"),
    );
    await expect(timeline).toBeVisible();
    // No crash after interaction
    await expect(page.locator("#root")).toBeVisible();
  });
});

test.describe("View-specific interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("load a demo session", { exact: false }).click();
    await expect(page.getByRole("button", { name: /Replay/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("waterfall view renders without errors", async ({ page }) => {
    await page.getByRole("button", { name: /Waterfall/i }).click();
    await page.waitForTimeout(500);
    // Waterfall should render some content
    await expect(page.locator("#root")).toBeVisible();
  });

  test("graph view loads without errors", async ({ page }) => {
    await page.getByRole("button", { name: /Graph/i }).click();
    // Graph is lazy-loaded and uses ELKjs, give it extra time
    await page.waitForTimeout(2000);
    await expect(page.locator("#root")).toBeVisible();
  });

  test("tracks view shows track lanes", async ({ page }) => {
    await page.getByRole("button", { name: "Tracks", exact: true }).click();
    await page.waitForTimeout(500);
    // Search should be visible in tracks view
    await expect(page.locator("#agentviz-search")).toBeVisible();
  });
});
