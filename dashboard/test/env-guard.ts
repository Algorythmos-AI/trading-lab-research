// The evidence-class guard for rendered pages (lib/env.ts). Page tests render a page or a pane and call
// `assertOnlyEnvs(tree, allowed)`. On the rendered markup:
//   - every money figure (`data-money`) sits inside an EnvFrame (`data-env-frame`), and the nearest frame around it is
//     of the figure's own class ("unframed", "mismatch");
//   - every other element that names a class (a chip, say) and sits inside a frame names the frame's class, so a
//     REAL · WEBULL chip cannot sit in a paper frame ("mismatch"); a chip outside every frame, in a heading, is fine;
//   - a frame nests only directly in the page or in a real frame, never inside a frame of another non-real class
//     or a real frame inside a paper one ("nested");
//   - every class named is one of the four ("unknown") and one the page allows ("not-allowed");
//   - the markup is well formed: every tag closes in order and every comment ends ("malformed"). React's own markup
//     always is; HTML injected with dangerouslySetInnerHTML may not be, and could otherwise hold a frame open.
// The text inside <script>, <style>, <textarea> and <title> is skipped: it is not markup.
//
// It reads the markup React renders on the server (renderToStaticMarkup / renderToString). React escapes "<", ">" and
// quotes inside text and attribute values, so a tag is always one "<...>" run.
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isEnv, type Env } from "@/lib/env";

export type Tree = string | ReactElement;

/** One thing wrong with a tree, in words a failing test can print. */
export type EnvViolation = {
  kind: "unframed" | "mismatch" | "nested" | "unknown" | "not-allowed" | "malformed";
  detail: string;
};

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const OPEN = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/y;
const CLOSE = /<\/([a-zA-Z][\w:-]*)\s*>/y;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attrs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(ATTR)) out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

const html = (tree: Tree) => (typeof tree === "string" ? tree : renderToStaticMarkup(tree));

/** An open element: its tag, and its class when it is a frame (null when it is not one). */
type Open = { tag: string; frame: string | null };

/** Every breach of the evidence-class rules on a tree; empty when it is clean. */
export function envViolations(tree: Tree, allowed?: readonly Env[]): EnvViolation[] {
  const s = html(tree);
  const out: EnvViolation[] = [];
  const stack: Open[] = [];
  const nearestFrame = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.frame !== null) return stack[k]!.frame;
    return null;
  };
  let money = 0;
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) {
        out.push({ kind: "malformed", detail: "a comment never ends: everything after it is hidden" });
        break;
      }
      i = end + 3;
      continue;
    }
    CLOSE.lastIndex = lt;
    const close = CLOSE.exec(s);
    if (close) {
      const tag = close[1]!.toLowerCase();
      const top = stack.at(-1);
      if (top?.tag === tag) stack.pop();
      else {
        out.push({ kind: "malformed", detail: `</${tag}> does not close the open <${top?.tag ?? "nothing"}>` });
        const at = stack.map((o) => o.tag).lastIndexOf(tag);
        if (at >= 0) stack.length = at;
      }
      i = CLOSE.lastIndex;
      continue;
    }
    OPEN.lastIndex = lt;
    const open = OPEN.exec(s);
    if (!open) {
      i = lt + 1; // a bare "<" in text
      continue;
    }
    i = OPEN.lastIndex;
    const tag = open[1]!.toLowerCase();
    const a = attrs(open[2] ?? "");
    const env = a.get("data-env");
    const isFrame = a.has("data-env-frame");
    if (env !== undefined) {
      if (!isEnv(env)) out.push({ kind: "unknown", detail: `<${tag}> has data-env="${env}", not an evidence class` });
      else if (allowed && !allowed.includes(env))
        out.push({ kind: "not-allowed", detail: `<${tag}> is ${env}; this page allows ${allowed.join(", ") || "none"}` });
    }
    const outer = nearestFrame();
    if (a.has("data-money")) {
      money += 1;
      const what = `money figure #${money} (${env ?? "no data-env"})`;
      if (env === undefined) out.push({ kind: "unknown", detail: `${what} has no data-env` });
      if (outer === null) out.push({ kind: "unframed", detail: `${what} is not inside an EnvFrame` });
      else if (env !== undefined && outer !== env) out.push({ kind: "mismatch", detail: `${what} sits in a ${outer} frame` });
    } else if (isFrame) {
      if (outer !== null && outer !== "real" && outer !== (env ?? ""))
        out.push({ kind: "nested", detail: `a ${env ?? "classless"} frame sits inside a ${outer} frame` });
    } else if (env !== undefined && outer !== null && outer !== env) {
      out.push({ kind: "mismatch", detail: `<${tag}> names ${env} inside a ${outer} frame` });
    }
    if (open[3] === "/" || VOID.has(tag)) continue;
    if (RAW_TEXT.has(tag)) {
      const end = new RegExp(`</${tag}\\s*>`, "ig");
      end.lastIndex = i;
      const e = end.exec(s);
      if (!e) {
        out.push({ kind: "malformed", detail: `<${tag}> never closes` });
        break;
      }
      i = e.index + e[0].length;
      continue;
    }
    stack.push({ tag, frame: isFrame ? (env ?? "") : null });
  }
  for (const o of stack) out.push({ kind: "malformed", detail: `<${o.tag}>${o.frame !== null ? ` (a ${o.frame} frame)` : ""} never closes` });
  return out;
}

/**
 * Throws, listing every breach, unless the tree keeps the evidence-class rules above and every class on it is in
 * `allowed`. Returns the classes found, so a test can also check the page shows the ones it should.
 */
export function assertOnlyEnvs(tree: Tree, allowed: readonly Env[]): Set<Env> {
  const markup = html(tree);
  const bad = envViolations(markup, allowed);
  if (bad.length)
    throw new Error(`evidence-class guard: ${bad.length} breach(es)\n${bad.map((v) => `  ${v.kind}: ${v.detail}`).join("\n")}`);
  const found = new Set<Env>();
  for (const m of markup.matchAll(/\sdata-env="([^"]*)"/g)) if (isEnv(m[1])) found.add(m[1]);
  return found;
}
