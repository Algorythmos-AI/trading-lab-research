import { expect, test } from "@playwright/test";
import { liveChips, scan, useTheme } from "./axe";

// CI-only. Every stocks page, in both themes, must pass axe's WCAG 2.1 A and AA rules with nothing waived. The
// Options page is also scanned in its failure states, since an error notice has to be as readable as the data.
const PAGES = [
  "/",
  "/today",
  "/radar",
  "/options?view=brief",
  "/options?view=live",
  "/options?view=review",
  "/options?view=classic",
  "/strategies",
  "/research",
  "/operations",
  "/risk",
  "/engineering",
  "/glossary",
];
const OPTIONS_STATES = ["partial", "poison", "empty", "error"];

// These run at desktop width. The Options desk is also scanned at a phone's width, in a11y-phone.spec.ts; the other
// pages are not yet, and wide tables that scroll sideways on a phone are a known gap there.
test.skip(({ isMobile }) => isMobile, "these scans run on the desktop project");

for (const theme of ["light", "dark"] as const) {
  for (const path of PAGES) {
    test(`${path} passes the accessibility scan in ${theme}`, async ({ page, context }) => {
      await useTheme(context, theme);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      if (path.startsWith("/options")) await liveChips(page);
      expect(await scan(page)).toEqual([]);
    });
  }

  test(`the command palette passes the accessibility scan in ${theme}, open and with nothing matching`, async ({ page, context }) => {
    await useTheme(context, theme);
    await page.goto("/options?view=live");
    // The live chips only appear once the desk is interactive, so the shortcut below is not lost.
    await liveChips(page);
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Search names and actions" });
    await expect(palette.getByRole("combobox")).toBeFocused();
    expect(await scan(page)).toEqual([]);
    await page.keyboard.type("zzzz");
    await expect(palette).toContainText("Nothing matches");
    expect(await scan(page)).toEqual([]);
  });

  for (const fx of OPTIONS_STATES) {
    test(`/options in the ${fx} state passes the accessibility scan in ${theme}`, async ({ page, context, baseURL }) => {
      await useTheme(context, theme);
      await context.addCookies([{ name: "fx", value: fx, url: baseURL! }]);
      // Live view, so the monitor carries state chips on highlighted and selected rows.
      await page.goto("/options?view=live");
      await expect(page.getByRole("heading", { level: 1, name: "Options" })).toBeAttached();
      if (fx === "partial" || fx === "poison") await liveChips(page);
      expect(await scan(page)).toEqual([]);
    });
  }
}
