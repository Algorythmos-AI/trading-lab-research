// Collects original posts from an X search results page ("Latest" tab).
// Usage: see COLLECT.md. Paste into the page console (or run it through a browser tool) on
//   https://x.com/search?q=from%3ADesi_Trade%20since%3AYYYY-MM-DD%20until%3AYYYY-MM-DD%20-filter%3Areplies&f=live
// It scrolls until no new posts appear for 12 rounds, then adds a "Copy posts" button at the top
// left of the page. Clicking it copies a JSON array to the clipboard (one object per post).
// Fields: id, url, ts_utc, text, quoted_id, quoted_text, image_ids, has_video.
(() => {
  const AUTHOR = "Desi_Trade";
  const posts = {};
  const idOf = (href) => (href.match(/\/status\/(\d+)/) || [])[1] || null;

  function harvest() {
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const time = art.querySelector("time");
      const link = time && time.closest("a");
      if (!link) continue;
      const href = link.getAttribute("href") || "";
      if (!href.startsWith(`/${AUTHOR}/status/`)) continue; // only the author's own posts
      const id = idOf(href);
      if (!id || posts[id]) continue;
      const texts = [...art.querySelectorAll('[data-testid="tweetText"]')];
      // The first tweetText is the post; a second one, if any, belongs to the quoted post.
      const quoteBox = [...art.querySelectorAll('div[role="link"]')].find((d) =>
        d.querySelector('[data-testid="tweetText"]'));
      let quotedId = null;
      if (quoteBox) {
        const qa = [...quoteBox.querySelectorAll('a[href*="/status/"]')][0];
        quotedId = qa ? idOf(qa.getAttribute("href")) : null;
      }
      const mainText = texts.find((t) => !(quoteBox && quoteBox.contains(t)));
      const quoteText = quoteBox ? quoteBox.querySelector('[data-testid="tweetText"]') : null;
      const images = [...art.querySelectorAll('[data-testid="tweetPhoto"] img')]
        .filter((img) => !(quoteBox && quoteBox.contains(img)))
        .map((img) => ((img.src.split("/media/")[1] || "").split("?")[0]))
        .filter(Boolean);
      posts[id] = {
        id,
        url: `https://x.com/${AUTHOR}/status/${id}`,
        ts_utc: time.getAttribute("datetime"),
        text: mainText ? mainText.innerText : "",
        quoted_id: quotedId,
        quoted_text: quoteText ? quoteText.innerText : null,
        image_ids: [...new Set(images)],
        has_video: !!art.querySelector('[data-testid="videoPlayer"], video'),
      };
    }
  }

  function addButton() {
    const b = document.createElement("button");
    b.id = "wt-copy-posts";
    b.textContent = `Copy posts (${Object.keys(posts).length})`;
    Object.assign(b.style, { position: "fixed", top: "8px", left: "8px", zIndex: 99999,
      padding: "16px 24px", fontSize: "20px", background: "#1d9bf0", color: "#fff" });
    b.onclick = () => {
      const ta = document.createElement("textarea");
      ta.value = JSON.stringify(Object.values(posts).sort((a, b) => (a.ts_utc < b.ts_utc ? -1 : 1)));
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      b.textContent = "Copied";
    };
    document.body.appendChild(b);
  }

  window.__wtPosts = posts;
  window.__wtDone = false;
  (async () => {
    await new Promise((r) => setTimeout(r, 3000));
    let stale = 0;
    let last = 0;
    for (let i = 0; i < 800 && stale < 12; i++) {
      harvest();
      const n = Object.keys(posts).length;
      stale = n === last ? stale + 1 : 0;
      last = n;
      window.scrollBy(0, 2500);
      await new Promise((r) => setTimeout(r, 1500));
    }
    harvest();
    addButton();
    window.__wtDone = true;
  })();
})();
