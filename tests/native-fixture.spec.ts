import { expect, test } from "@playwright/test";

const url = "http://127.0.0.1:4173";

test.describe("NativeInteractionBench fixture self-tests (not Host BENCH-NIF evidence)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url);
  });

  test("TEST-NIF-001 move + click", async ({ page }) => {
    await page.locator("#click").click();
    await expect(page.locator("#click-count")).toHaveText("1");
  });

  test("TEST-NIF-002 double click", async ({ page }) => {
    await page.locator("#double").dblclick();
    await expect(page.locator("#double-count")).toHaveText("1");
  });

  test("TEST-NIF-003 hover-triggered menu", async ({ page }) => {
    await page.locator("#hover-zone").hover();
    await expect(page.locator("#hover-menu")).toBeVisible();
    await expect(page.locator("#click-count")).toHaveText("0");
  });

  test("TEST-NIF-004 vertical scroll", async ({ page }) => {
    await page.locator("#vscroll").hover();
    await page.mouse.wheel(0, 360);
    await expect
      .poll(() => page.locator("#vscroll").evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await expect(page.locator("#v-end")).toBeInViewport();
  });

  test("TEST-NIF-005 horizontal scroll", async ({ page }) => {
    await page.locator("#hscroll").hover();
    await page.mouse.wheel(600, 0);
    await expect
      .poll(() => page.locator("#hscroll").evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(0);
    await expect(page.locator("#h-end")).toBeInViewport();
  });

  test("TEST-NIF-006 drag slider", async ({ page }) => {
    const bounds = await page.locator("#slider").boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + 10, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      bounds!.x + bounds!.width * 0.85,
      bounds!.y + bounds!.height / 2,
    );
    await page.mouse.up();
    await expect
      .poll(async () => Number(await page.locator("#slider").inputValue()))
      .toBeGreaterThan(60);
  });

  test("TEST-NIF-007 drag and drop", async ({ page }) => {
    await page.locator("#drag-source").dragTo(page.locator("#drop-target"));
    await expect(page.locator("#drop-target")).toHaveText("dropped");
  });

  test("TEST-NIF-008 typing", async ({ page }) => {
    await page.locator("#typing").pressSequentially("rail-42");
    await expect(page.locator("#typed")).toHaveText("rail-42");
  });

  test("TEST-NIF-009 keyboard shortcut", async ({ page }) => {
    await page.locator("#shortcut").focus();
    await page.keyboard.press("Control+s");
    await expect(page.locator("#shortcut-state")).toHaveText("saved");
  });

  test("TEST-NIF-010 focus switching", async ({ page }) => {
    await page.locator("#focus-a").click();
    await expect(page.locator("#focus-a")).toBeFocused();
    await page.locator("#focus-b").click();
    await expect(page.locator("#focus-b")).toBeFocused();
  });

  test("TEST-NIF-011 dropdown", async ({ page }) => {
    await page.locator("#select").selectOption("b");
    await expect(page.locator("#selected")).toHaveText("b");
  });

  test("TEST-NIF-012 iframe", async ({ page }) => {
    const frame = page.frameLocator("#frame");
    await frame.locator("#frame-button").click();
    await expect(frame.locator("#frame-output")).toHaveText("1");
  });

  test("TEST-NIF-013 canvas visual target", async ({ page }) => {
    const bounds = await page.locator("#canvas").boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(
      bounds!.x + bounds!.width * 0.75,
      bounds!.y + bounds!.height / 2,
    );
    await expect(page.locator("#canvas-zone")).toHaveText("right");
  });

  test("TEST-NIF-014 rerender invalidates old target", async ({ page }) => {
    const original = await page.locator("#rerender button").elementHandle();
    await page.locator("#rerender button").click();
    await expect(page.locator("#rerender button")).toHaveAttribute(
      "data-generation",
      "2",
    );
    expect(await original!.evaluate((node) => node.isConnected)).toBe(false);
  });

  test("TEST-NIF-015 new tab", async ({ page }) => {
    const popupPromise = page.waitForEvent("popup");
    await page.locator("#new-tab").click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(new URL(popup.url()).searchParams.get("tab")).toBe("child");
    await popup.close();
  });

  test("TEST-NIF-016 modal", async ({ page }) => {
    await page.locator("#open-modal").click();
    await expect(page.locator("#modal")).toBeVisible();
    await page.locator("#close-modal").click();
    await expect(page.locator("#modal")).not.toBeVisible();
  });

  test("TEST-NIF-017 human takeover then resume", async ({ page }) => {
    await page.locator("#takeover").click();
    await expect(page.locator("#lease")).toHaveText("human");
    await expect(page.locator("#target-generation")).toHaveText("2");
    await page.locator("#resume").click();
    await expect(page.locator("#lease")).toHaveText("agent");
  });

  test("TEST-NIF-018 native cursor only", async ({ page }) => {
    await page.locator("#click").click();
    await expect(page.locator(".oxrail-cursor")).toHaveCount(0);
    const pointerEvents = await page.evaluate(() =>
      (
        window as typeof window & {
          fixture: { state: { events: { type: string }[] } };
        }
      ).fixture.state.events
        .filter(({ type }) => type.startsWith("pointer"))
        .map(({ type }) => type),
    );
    expect(pointerEvents).toEqual(["pointerdown", "pointerup"]);
  });

  test("TEST-NIF-019 viewport DPR mapping", async ({ browser }) => {
    const context = await browser.newContext({
      deviceScaleFactor: 1.25,
      viewport: { width: 1000, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(url);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.25);
    const bounds = await page.locator("#canvas").boundingBox();
    await page.mouse.click(
      bounds!.x + bounds!.width * 0.25,
      bounds!.y + bounds!.height / 2,
    );
    await expect(page.locator("#canvas-zone")).toHaveText("left");
    await context.close();
  });

  test("TEST-NIF-020 frame feedback", async ({ page }) => {
    await expect(page.locator("#frame-id")).toHaveText("frame-1");
    await page.locator("#frame-feedback").click();
    await expect(page.locator("#frame-id")).toHaveText("frame-2");
  });

  test("TEST-NIF-021 ordinary action pass-through", async ({ page }) => {
    await page.locator("#click").click();
    const state = await page.evaluate(
      () =>
        (
          window as typeof window & {
            fixture: {
              state: { disposition: string; events: { type: string }[] };
            };
          }
        ).fixture.state,
    );
    expect(state.disposition).toBe("PASS_THROUGH");
    expect(state.events.filter(({ type }) => type === "click")).toHaveLength(1);
  });

  test("TEST-NIF-022 no-op overlay policy", async ({ page }) => {
    const before = await page.locator("main").boundingBox();
    await expect(page.locator("[class^=oxrail-], [id^=oxrail-]")).toHaveCount(
      0,
    );
    expect(await page.locator("main").boundingBox()).toEqual(before);
  });

  test("TEST-NIF-023 normal action false block", async ({ page }) => {
    const result = await page.evaluate(() => {
      const fixture = (
        window as typeof window & {
          fixture: { state: { disposition: string } };
        }
      ).fixture;
      return {
        disposition: fixture.state.disposition,
        disabledControls: document.querySelectorAll(
          "button:disabled, input:disabled, select:disabled",
        ).length,
      };
    });
    expect(result).toEqual({
      disposition: "PASS_THROUGH",
      disabledControls: 0,
    });
  });
});
