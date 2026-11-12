// A fake of the @vercel/blob SDK that behaves like the real store where it matters here:
//  * head() returns the store's etag, the one put({ ifMatch }) compares against;
//  * get() returns the *delivery* etag (a weak, quoted header), which put({ ifMatch }) rejects;
//  * put() enforces ifMatch and create-only (allowOverwrite: false) strictly;
//  * head() also returns uploadedAt, the time of the write its etag names (a fixed clock, one ms per write, so two
//    runs from reset() store the same bytes).
// The mismatch between the two etags is what broke every publish after the first in production.
export function makeFakeBlobSdk() {
  class BlobError extends Error {}
  class BlobNotFoundError extends BlobError {}
  class BlobPreconditionFailedError extends BlobError {}
  const store = new Map<string, { text: string; etag: string }>();
  const uploaded = new Map<string, Date>();
  const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
  const hooks: {
    betweenHeadAndGet?: (pathname: string) => void;
    beforePut?: (pathname: string, body: string) => void;
  } = {};
  let seq = 0;
  let headed = new Set<string>();
  const write = (pathname: string, text: string) => {
    const etag = `"s${++seq}"`;
    store.set(pathname, { text, etag });
    uploaded.set(pathname, new Date(EPOCH + seq));
    return etag;
  };
  return {
    store,
    hooks,
    write,
    reset() {
      store.clear();
      uploaded.clear();
      seq = 0;
      headed = new Set();
      hooks.betweenHeadAndGet = undefined;
      hooks.beforePut = undefined;
    },
    BlobError,
    BlobNotFoundError,
    BlobPreconditionFailedError,
    async head(pathname: string) {
      const b = store.get(pathname);
      if (!b) throw new BlobNotFoundError("The requested blob does not exist");
      headed.add(pathname);
      return { etag: b.etag, pathname, url: `https://blob.test/${pathname}`, uploadedAt: uploaded.get(pathname)! };
    },
    async get(pathname: string) {
      if (headed.has(pathname)) {
        headed.delete(pathname);
        hooks.betweenHeadAndGet?.(pathname);
      }
      const b = store.get(pathname);
      if (!b) return null;
      return {
        statusCode: 200 as const,
        stream: new Response(b.text).body,
        headers: new Headers(),
        blob: { etag: `W/${b.etag}`, pathname },
      };
    },
    async put(pathname: string, body: string, opts: { ifMatch?: string; allowOverwrite?: boolean } = {}) {
      hooks.beforePut?.(pathname, body);
      const cur = store.get(pathname);
      if (opts.ifMatch !== undefined && cur?.etag !== opts.ifMatch) throw new BlobPreconditionFailedError("precondition failed");
      if (opts.allowOverwrite === false && cur) throw new BlobError("This blob already exists");
      return { etag: write(pathname, body), pathname, url: `https://blob.test/${pathname}` };
    },
    async list() {
      return { blobs: [...store.keys()].map((k) => ({ pathname: k, url: `https://blob.test/${k}` })), hasMore: false };
    },
    async del(urls: string[]) {
      for (const u of urls) {
        store.delete(u.replace("https://blob.test/", ""));
        uploaded.delete(u.replace("https://blob.test/", ""));
      }
    },
  };
}
