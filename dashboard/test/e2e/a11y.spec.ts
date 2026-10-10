import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext } from "@playwright/test";

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
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// Scanned at desktop width only for now. The phone layout is scanned when the new Options layout lands; wide
// tables that scroll sideways on a phone are a known gap there.
test.skip(({ isMobile }) => isMobile, "accessibility scan runs on the desktop project");

/**
 * On the Options pages, wait until the live feed has drawn its state chips. Scanning before the first quote
 * arrives would judge a page with no chips on it, and whether a scan saw them would depend on timing.
 */
async function liveChips(page: import("@playwright/test").Page) {
  await expect(page.locator("main")).toContainText("TESTING RESISTANCE");
}

async function scan(page: import("@playwright/test").Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes[0]?.target.join(" ") ?? ""}`);
}

async function useTheme(context: BrowserContext, theme: "light" | "dark") {
  // The theme is read from storage before first paint, so no colour is caught half way through a transition.
  await context.addInitScript((t) => window.localStorage.setItem("tl-theme", t), theme);
}

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
