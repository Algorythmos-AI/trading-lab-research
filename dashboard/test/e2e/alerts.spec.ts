import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The rail's alerts (sound and the browser's notification) on the scripted morning (fixture-script.ts): step
// 2 has QQQ getting ready, step 3 has it in the zone, which rings. The browser's audio and notifications are stood in
// for by small fakes that count what the page asks of them, so the tests hear and see every ring.

async function at(context: BrowserContext, baseURL: string | undefined, step: number) {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script", url: baseURL! },
    { name: "fxstep", value: String(step), url: baseURL! },
  ]);
}

type Fakes = { tones: number; contexts: number; notes: { title: string; tag?: string; renotify?: boolean }[]; hidden: boolean };

/** Fakes for AudioContext and Notification, and a switch for the page's visibility; `saved` is the stored choice. */
async function fakes(page: Page, opts: { saved?: object; permission?: NotificationPermission } = {}) {
  await page.addInitScript(
    ({ saved, permission }) => {
      const w = window as unknown as { __fx: Fakes } & Record<string, unknown>;
      w.__fx = { tones: 0, contexts: 0, notes: [], hidden: false };
      if (saved) window.localStorage.setItem("trade-now-alerts", JSON.stringify(saved));
      class FakeParam {
        value = 0;
        setValueAtTime() {}
        linearRampToValueAtTime() {}
        exponentialRampToValueAtTime() {}
        cancelScheduledValues() {}
      }
      class FakeNode {
        connect() {}
        disconnect() {}
      }
      class FakeAudio extends EventTarget {
        state: AudioContextState = "suspended";
        currentTime = 0;
        destination = new FakeNode();
        constructor() {
          super();
          w.__fx.contexts++;
        }
        resume() {
          // A browser runs the context only after a click or key on the page.
          if (navigator.userActivation?.hasBeenActive) {
            this.state = "running";
            this.dispatchEvent(new Event("statechange"));
          }
          return Promise.resolve();
        }
        createGain() {
          return Object.assign(new FakeNode(), { gain: new FakeParam() });
        }
        createOscillator() {
          return Object.assign(new FakeNode(), {
            type: "sine",
            frequency: new FakeParam(),
            start: () => {
              if (this.state === "running") w.__fx.tones++;
            },
            stop() {},
          });
        }
      }
      w.AudioContext = FakeAudio;
      let perm: NotificationPermission = permission ?? "default";
      class FakeNotification {
        static get permission() {
          return perm;
        }
        static requestPermission() {
          perm = "granted";
          return Promise.resolve(perm);
        }
        onclick: (() => void) | null = null;
        constructor(title: string, o: { tag?: string; renotify?: boolean } = {}) {
          if (perm !== "granted") throw new TypeError("not allowed");
          w.__fx.notes.push({ title, tag: o.tag, renotify: o.renotify });
        }
        close() {}
      }
      w.Notification = FakeNotification;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (w.__fx.hidden ? "hidden" : "visible") });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => w.__fx.hidden });
    },
    { saved: opts.saved ?? null, permission: opts.permission ?? "default" },
  );
  return {
    read: () => page.evaluate(() => (window as unknown as { __fx: Fakes }).__fx),
    hide: () =>
      page.evaluate(() => {
        (window as unknown as { __fx: Fakes }).__fx.hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      }),
  };
}

const rows = (page: Page) => page.locator("[data-trade-now] [data-board-row]");
const alertsButton = (page: Page) => page.getByRole("button", { name: /^Alerts/ });
const panel = (page: Page) => page.locator("#trade-now-alerts");

test("sound saved on still rings after a reload, once the page has had a click", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 2);
  const fx = await fakes(page, { saved: { sound: true, notify: false } });
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  // the rail says sound waits for a tap rather than claiming it works
  await alertsButton(page).click();
  await expect(panel(page).locator("[data-alert-status='sound']")).toHaveText(/ready/i);
  await page.keyboard.press("Escape");
  await at(context, baseURL, 3);
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone", { timeout: 15_000 });
  await expect.poll(async () => (await fx.read()).tones, { timeout: 5_000 }).toBeGreaterThan(0);
});

test("before any click the sound switch says to tap, and nothing claims to ring", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 2);
  await fakes(page, { saved: { sound: true, notify: false } });
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await expect(alertsButton(page)).toHaveAttribute("data-alerts-tone", "warn");
  await expect(alertsButton(page)).toHaveAccessibleName(/tap/i);
});

test("a notification switch whose permission was taken away reads blocked, not on", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await fakes(page, { saved: { sound: false, notify: true }, permission: "denied" });
  await page.goto("/options");
  await alertsButton(page).click();
  const sw = panel(page).getByRole("button", { name: "Browser notification", exact: true });
  await expect(sw).toHaveAttribute("aria-pressed", "false");
  await expect(panel(page).locator("[data-alert-status='notify']")).toContainText("Blocked");
  await expect(alertsButton(page)).toHaveAttribute("data-alerts-tone", "warn");
});

test("a ring reaches a hidden tab: the board keeps reading while an alert is on", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 2);
  const fx = await fakes(page, { saved: { sound: false, notify: true }, permission: "granted" });
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await fx.hide();
  await at(context, baseURL, 3);
  await expect.poll(async () => (await fx.read()).notes.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const notes = (await fx.read()).notes;
  expect(notes.every((n) => n.renotify === true)).toBe(true);
});

test("the test buttons sound and notify without touching the board's log", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  const fx = await fakes(page, { permission: "granted" });
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  const logName = await page.locator("[data-today-log-button]").innerText();
  await alertsButton(page).click();
  await panel(page).getByRole("button", { name: "Test sound" }).click();
  await expect.poll(async () => (await fx.read()).tones).toBeGreaterThan(0);
  await panel(page).getByRole("button", { name: "Test notification" }).click();
  await expect.poll(async () => (await fx.read()).notes.length).toBe(1);
  expect((await fx.read()).notes[0]?.title).toMatch(/test/i);
  expect(await page.locator("[data-today-log-button]").innerText()).toBe(logName);
});

test("the alerts menu closes on Escape and gives the focus back", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await fakes(page);
  await page.goto("/options");
  const b = alertsButton(page);
  await b.click();
  await expect(b).toHaveAttribute("aria-expanded", "true");
  await expect(panel(page).getByRole("button", { name: "Sound", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(b).toHaveAttribute("aria-expanded", "false");
  await expect(b).toBeFocused();
});

test("turning sound on rings nothing by itself: only a new change on the board does", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  const fx = await fakes(page);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await alertsButton(page).click();
  await panel(page).getByRole("button", { name: "Sound", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "Sound", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel(page).locator("[data-alert-status='sound']")).toHaveText(/ready/i);
  await page.waitForTimeout(4_000);
  expect((await fx.read()).tones).toBe(0);
  await expect(alertsButton(page)).toHaveAttribute("data-alerts-tone", "good");
});

test("on a phone the alerts menu is a sheet inside the screen's gutters, and its switches are a finger's size", async ({ page, context, baseURL, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  await at(context, baseURL, 3);
  await fakes(page);
  await page.goto("/options");
  await alertsButton(page).click();
  const box = (await panel(page).boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(15);
  expect(box.x + box.width).toBeLessThanOrEqual(vw - 15);
  const sw = (await panel(page).getByRole("button", { name: "Sound", exact: true }).boundingBox())!;
  expect(sw.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("turning the notification on shows one notice first, and stays off where the browser refuses it", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  const fx = await fakes(page, { permission: "granted" });
  await page.goto("/options");
  await alertsButton(page).click();
  const sw = panel(page).getByRole("button", { name: "Browser notification", exact: true });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-pressed", "true");
  expect((await fx.read()).notes.map((n) => n.title)).toEqual(["Alerts on"]);
});
