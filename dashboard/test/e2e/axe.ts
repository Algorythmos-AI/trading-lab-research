import AxeBuilder from "@axe-core/playwright";
import { expect, type BrowserContext, type Page } from "@playwright/test";

// Shared by the accessibility scans: axe's WCAG 2.1 A and AA rules, with nothing waived.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * On the Options pages, wait until the live feed has drawn its state chips. Scanning before the first quote
 * arrives would judge a page with no chips on it, and whether a scan saw them would depend on timing.
 *
 * It waits for a chip that is on screen, a badge. The words alone are not enough: "TESTING RESISTANCE" is also in
 * the help text the server sends, so a wait on the words passed at once, before the page was even interactive. And
 * on a phone the list of names, which holds the first such chip, may be behind the open name.
 */
export async function liveChips(page: Page) {
  await expect(page.locator('[data-slot="badge"]:visible', { hasText: "TESTING RESISTANCE" }).first()).toBeVisible();
}

export async function scan(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes[0]?.target.join(" ") ?? ""}`);
}

export async function useTheme(context: BrowserContext, theme: "light" | "dark") {
  // The theme is read from storage before first paint, so no colour is caught half way through a transition.
  await context.addInitScript((t) => window.localStorage.setItem("tl-theme", t), theme);
}
