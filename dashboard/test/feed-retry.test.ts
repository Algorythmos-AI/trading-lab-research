import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHAIN_POLL_MS, chainFresh } from "@/components/client/use-chain";
import { retryInS, retrySpoken } from "@/components/client/live-layer";

const b = (at: number | null, limited = false) => ({ failures: 1, at, limited });

describe("retryInS: the countdown as the page's one-second clock reads it", () => {
  // useNow floors the clock to the second, so `now` is up to 999 ms behind the real time.
  it("reads 2 at the first look at a 2 s wait, wherever in its second the wait began", () => {
    for (const lag of [0, 1, 500, 999]) {
      const real = 10_000_000 + lag; // when the wait began
      const now = Math.floor(real / 1000) * 1000; // what useNow says then
      expect(retryInS(b(real + 2_000), now)).toBe(2);
    }
  });

  it("counts down to 1 and never below while any of the wait remains, then 0 once due", () => {
    const at = 50_000;
    expect(retryInS(b(at), at - 2_000)).toBe(2);
    expect(retryInS(b(at), at - 1_999)).toBe(1);
    expect(retryInS(b(at), at - 1_000)).toBe(1);
    expect(retryInS(b(at), at - 1)).toBe(1);
    expect(retryInS(b(at), at)).toBe(0);
    expect(retryInS(b(at), at + 5)).toBe(0);
    expect(retryInS(b(at), at - 30_000)).toBe(30);
  });

  it("is null while the attempt is out, and before the page has a clock", () => {
    expect(retryInS(b(null), 1)).toBeNull();
    expect(retryInS(b(5), null)).toBeNull();
  });
});

describe("retrySpoken: what the retry line announces", () => {
  it("is empty while healthy, and changes only with the reason, not with the count or the attempt", () => {
    expect(retrySpoken(null)).toBe("");
    const plain = retrySpoken(b(1_000));
    expect(retrySpoken(b(9_000))).toBe(plain);
    expect(retrySpoken(b(null))).toBe(plain);
    expect(retrySpoken({ failures: 4, at: 2, limited: false })).toBe(plain);
    expect(retrySpoken(b(1_000, true))).not.toBe(plain);
    expect(retrySpoken(b(null, true))).toBe(retrySpoken(b(1_000, true)));
    expect(plain).not.toMatch(/\d+ ?s\b/);
  });
});

describe("chainFresh: a tab shown again asks the option chain for nothing within half a minute of a good answer", () => {
  it("holds below the poll interval and lets the fetch through at it", () => {
    expect(chainFresh(1_000, 1_000)).toBe(true);
    expect(chainFresh(1_000, 1_000 + CHAIN_POLL_MS - 1)).toBe(true);
    expect(chainFresh(1_000, 1_000 + CHAIN_POLL_MS)).toBe(false);
    expect(chainFresh(Number.NEGATIVE_INFINITY, 5)).toBe(false); // never answered
  });
});

describe("FeedRetry", () => {
  it("draws nothing but an empty live region outside a provider (no wait)", () => {
    // The default context has no wait: only the polite status region, which is always there.
    return import("@/components/client/live-layer").then(({ FeedRetry }) => {
      const html = renderToStaticMarkup(createElement(FeedRetry));
      expect(html).toBe('<p data-feed-retry-spoken="true" role="status" aria-live="polite" class="sr-only"></p>');
    });
  });
});
