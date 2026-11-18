import { describe, expect, it, vi } from "vitest";
import { type NotificationCtor, notifyState, readPermission, ringTag, sendNotice } from "@/lib/alert-notify";
import { type AudioContextLike, EXIT_BOOST, GAIN, soundEngine, TONES } from "@/lib/alert-sound";
import { parseAlerts } from "@/components/client/alert-prefs";
import { alertsLabel, alertsTone, closeEntryNotices, ringAlerts } from "@/components/client/alerts";

/** A fake AudioContext that records the notes started; it runs only once `resume` is allowed. */
function fakeAudio(allow: { now: boolean }) {
  const started: { f: number; peak: number }[] = [];
  const listeners: (() => void)[] = [];
  const ctx = {
    state: "suspended" as string,
    currentTime: 5,
    destination: {},
    resume: vi.fn(async () => {
      if (allow.now) {
        ctx.state = "running";
        listeners.forEach((f) => f());
      }
    }),
    addEventListener: (_: "statechange", fn: () => void) => void listeners.push(fn),
    createGain() {
      let peak = 0;
      const gain = {
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: (v: number) => void (peak = v),
        exponentialRampToValueAtTime: () => undefined,
      };
      return { gain, connect: () => undefined, get peak() { return peak; } };
    },
    createOscillator() {
      let f = 0;
      const osc = {
        type: "",
        frequency: { setValueAtTime: (v: number) => void (f = v), linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
        connect: (g: { peak: number }) => void (gainOf = g),
        start: () => started.push({ f, peak: gainOf?.peak ?? 0 }),
        stop: () => undefined,
      };
      let gainOf: { peak: number } | null = null;
      return osc;
    },
  };
  return { ctx: ctx as unknown as AudioContextLike & { state: string }, started, resume: ctx.resume };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("soundEngine", () => {
  it("F1: a choice kept from an earlier visit plays nothing and says 'needs-tap' until the page has a click", async () => {
    const allow = { now: false };
    const a = fakeAudio(allow);
    const e = soundEngine(() => a.ctx);
    expect(e.state()).toBe("needs-tap");
    expect(e.play("entry", "normal")).toBe("needs-tap");
    await flush();
    expect(a.started).toHaveLength(0); // nothing scheduled to sound late after a click
    allow.now = true; // the owner clicks anywhere
    e.unlock();
    await flush();
    expect(e.state()).toBe("ready");
    expect(e.play("entry", "normal")).toBe("played");
    expect(a.started.map((n) => n.f)).toEqual(TONES.entry.map((n) => n.f));
  });

  it("makes one context only, however many rings and clicks", async () => {
    const make = vi.fn(() => fakeAudio({ now: true }).ctx);
    const e = soundEngine(make);
    e.unlock();
    e.unlock();
    e.play("entry", "normal");
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("an exit sounds different from an entry, and louder at the same volume", async () => {
    const a = fakeAudio({ now: true });
    const e = soundEngine(() => a.ctx);
    e.unlock();
    await flush();
    e.play("entry", "normal");
    const entry = a.started.splice(0);
    e.play("exit", "normal");
    const exit = a.started.splice(0);
    expect(exit.map((n) => n.f)).not.toEqual(entry.map((n) => n.f));
    expect(exit.length).toBe(3);
    expect(exit[0]!.peak).toBeCloseTo(GAIN.normal * EXIT_BOOST);
    expect(entry[0]!.peak).toBeCloseTo(GAIN.normal);
  });

  it("follows the volume step, and never goes above 0.5", async () => {
    const a = fakeAudio({ now: true });
    const e = soundEngine(() => a.ctx);
    e.unlock();
    await flush();
    e.play("entry", "quiet");
    e.play("exit", "loud");
    expect(a.started[0]!.peak).toBeCloseTo(GAIN.quiet);
    expect(Math.max(...a.started.map((n) => n.peak))).toBeLessThanOrEqual(0.5);
  });

  it("a browser with no audio says 'unsupported', also when making the context throws", () => {
    expect(soundEngine(() => null).play("entry", "normal")).toBe("unsupported");
    const e = soundEngine(() => {
      throw new Error("no audio");
    });
    e.unlock();
    expect(e.state()).toBe("unsupported");
  });

  it("a context the browser has closed is replaced on the next click", async () => {
    const first = fakeAudio({ now: true });
    const second = fakeAudio({ now: true });
    const make = vi.fn().mockReturnValueOnce(first.ctx).mockReturnValueOnce(second.ctx);
    const e = soundEngine(make);
    await e.unlock();
    expect(e.state()).toBe("ready");
    (first.ctx as { state: string }).state = "closed";
    await e.unlock();
    expect(make).toHaveBeenCalledTimes(2);
    expect(e.play("exit", "normal")).toBe("played");
    expect(second.started).toHaveLength(3);
  });

  it("unlock settles once the browser has answered, so a test played right after it sounds", async () => {
    const a = fakeAudio({ now: true });
    const e = soundEngine(() => a.ctx);
    await e.unlock();
    expect(e.play("entry", "normal")).toBe("played");
  });

  it("tells its listeners when the context starts running", async () => {
    const a = fakeAudio({ now: true });
    const e = soundEngine(() => a.ctx);
    const seen = vi.fn();
    e.subscribe(seen);
    e.unlock();
    await flush();
    expect(seen).toHaveBeenCalled();
  });
});

describe("notifyState", () => {
  it("F3: the switch is on only when chosen AND the browser allows it", () => {
    expect(notifyState(true, "granted")).toBe("on");
    expect(notifyState(true, "denied")).toBe("blocked");
    expect(notifyState(false, "denied")).toBe("blocked");
    expect(notifyState(true, "default")).toBe("ask");
    expect(notifyState(false, "granted")).toBe("off");
    expect(notifyState(true, "unsupported")).toBe("unsupported");
    expect(notifyState(true, "granted", true)).toBe("unsupported");
  });

  it("reads the permission as the browser holds it", () => {
    expect(readPermission(undefined)).toBe("unsupported");
    expect(readPermission({ permission: "denied" } as unknown as NotificationCtor)).toBe("denied");
    expect(readPermission({ permission: "weird" } as unknown as NotificationCtor)).toBe("unsupported");
  });
});

/** A fake Notification constructor that records what it was asked to show. */
function fakeNotification(permission: string, opts: { throws?: Error } = {}) {
  const shown: { title: string; o: Record<string, unknown>; note: { onclick: (() => void) | null; closed: boolean } }[] = [];
  const Ctor = function (this: unknown, title: string, o: Record<string, unknown> = {}) {
    if (opts.throws) throw opts.throws;
    const note = { onclick: null as (() => void) | null, closed: false, close() { note.closed = true; } };
    shown.push({ title, o, note });
    return note;
  } as unknown as NotificationCtor;
  Object.defineProperty(Ctor, "permission", { get: () => permission });
  (Ctor as unknown as { requestPermission: () => Promise<string> }).requestPermission = async () => permission;
  return { Ctor, shown };
}

describe("sendNotice", () => {
  it("F4: alerts again for a repeat (renotify) with a tag per name and side; an exit stays until dismissed", () => {
    const f = fakeNotification("granted");
    const onClick = vi.fn();
    const seen: unknown[] = [];
    expect(sendNotice(f.Ctor, { title: "QQQ: ENTER ZONE, call", body: "b", tag: ringTag("entry", "QQQ", "call"), onClick }, (n) => seen.push(n))).toBe("sent");
    expect(sendNotice(f.Ctor, { title: "QQQ: EXIT", body: "b", tag: ringTag("exit", "t1", null), sticky: true })).toBe("sent");
    expect(seen).toHaveLength(1); // the shown notice is handed back, so the board can take it down later
    expect(f.shown[0]!.o).toMatchObject({ tag: "trade-entry-QQQ-call", renotify: true, requireInteraction: false });
    expect(f.shown[1]!.o).toMatchObject({ renotify: true, requireInteraction: true });
    f.shown[0]!.note.onclick?.();
    expect(onClick).toHaveBeenCalledOnce();
    expect(f.shown[0]!.note.closed).toBe(true);
  });

  it("says blocked without permission, and unsupported where the constructor is refused (Android Chrome)", () => {
    expect(sendNotice(fakeNotification("denied").Ctor, { title: "t", body: "b", tag: "x" })).toBe("blocked");
    expect(sendNotice(undefined, { title: "t", body: "b", tag: "x" })).toBe("unsupported");
    const android = fakeNotification("granted", { throws: new TypeError("Illegal constructor") });
    expect(sendNotice(android.Ctor, { title: "t", body: "b", tag: "x" })).toBe("unsupported");
  });

  it("one tag per name and side: a newer word on the same side replaces the older notice, the other side stays apart", () => {
    expect(ringTag("entry", "SPY", "put")).toBe(ringTag("entry", "SPY", "put"));
    expect(ringTag("entry", "SPY", "put")).not.toBe(ringTag("entry", "SPY", "call"));
    expect(ringTag("entry", "SPY", null)).toBe("trade-entry-SPY-any");
  });
});

describe("parseAlerts", () => {
  it("reads an older save (no volume) as normal, and anything odd as off", () => {
    expect(parseAlerts('{"sound":true,"notify":false}')).toEqual({ sound: true, notify: false, volume: "normal" });
    expect(parseAlerts('{"sound":"yes","notify":1,"volume":"max"}')).toEqual({ sound: false, notify: false, volume: "normal" });
    expect(parseAlerts("not json")).toEqual({ sound: false, notify: false, volume: "normal" });
    expect(parseAlerts('{"sound":true,"volume":"loud"}').volume).toBe("loud");
  });
});

describe("the Alerts button's colour and name", () => {
  const both = { sound: true, notify: true };
  it("is green only when every chosen alert will reach the owner now", () => {
    expect(alertsTone(both, "ready", "on")).toBe("good");
    expect(alertsTone({ sound: true, notify: false }, "ready", "off")).toBe("good");
    expect(alertsTone({ sound: false, notify: false }, "off", "off")).toBe("neutral");
  });
  it("is amber when a chosen alert would not: sound waiting for a tap, notification blocked or unsupported", () => {
    expect(alertsTone(both, "needs-tap", "on")).toBe("warn");
    expect(alertsTone(both, "ready", "blocked")).toBe("warn");
    expect(alertsTone({ sound: false, notify: true }, "off", "ask")).toBe("warn");
    expect(alertsTone({ sound: false, notify: true }, "off", "unsupported")).toBe("warn");
    // a block on an alert not chosen is no reason to warn
    expect(alertsTone({ sound: false, notify: false }, "off", "blocked")).toBe("neutral");
  });
  it("names what each alert will do now", () => {
    expect(alertsLabel(both, "needs-tap", "blocked")).toBe("Alerts: sound needs a tap, notification blocked");
    expect(alertsLabel(both, "ready", "on")).toBe("Alerts: sound on, notification on");
    expect(alertsLabel({ sound: false, notify: false }, "off", "off")).toBe("Alerts: sound off, notification off");
  });
});

describe("the board's entry notices on the screen", () => {
  it("are taken down once their state has left the board; exits are not", () => {
    const f = fakeNotification("granted");
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Notification", f.Ctor);
    const on = { sound: false, notify: true, volume: "normal" as const };
    ringAlerts(on, "entry", [
      { title: "QQQ: ENTER ZONE, call", body: "b", tag: ringTag("entry", "QQQ", "call") },
      { title: "SPY: FAILED BREAK, put", body: "b", tag: ringTag("entry", "SPY", "put") },
    ]);
    ringAlerts(on, "exit", [{ title: "QQQ: EXIT", body: "b", tag: ringTag("exit", "t1", null), sticky: true }]);
    expect(f.shown).toHaveLength(3);
    closeEntryNotices(new Set([ringTag("entry", "SPY", "put")]));
    expect(f.shown.map((x) => x.note.closed)).toEqual([true, false, false]);
    closeEntryNotices(new Set()); // today marked done: every entry notice goes
    expect(f.shown.map((x) => x.note.closed)).toEqual([true, true, false]);
    vi.unstubAllGlobals();
  });
});
