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
      expect(await scan(page)).toEqual([]);
    });
  }

  for (const fx of OPTIONS_STATES) {
    test(`/options in the ${fx} state passes the accessibility scan in ${theme}`, async ({ page, context, baseURL }) => {
      await useTheme(context, theme);
      await context.addCookies([{ name: "fx", value: fx, url: baseURL! }]);
      await page.goto("/options?view=brief");
      await expect(page.getByRole("heading", { level: 1, name: "Options" })).toBeAttached();
      expect(await scan(page)).toEqual([]);
    });
  }
}
