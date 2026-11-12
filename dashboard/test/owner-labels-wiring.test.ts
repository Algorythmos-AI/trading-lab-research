// The labeller is wired to nothing. DEC-0045 point 5: "Before that release no one runs the labeller on the owner's
// journal", and DEC-0049 point 4 makes the fill-time check's pass a gate on that release. So no page, component, route
// or the desk's cron run may import an owner-labels module yet.
//
// The release pull request that first writes labels removes this test deliberately, in the same change that wires the
// labeller to its schedule and store. Until then a failure here means the labeller has been wired too early.
//
// Also: nothing in the server's shadow evaluation (desk-eval.ts's import closure, the files gen:engine hashes) may
// import the labeller, and the labeller's own import closure never reaches the site's feed setting or the board's bars.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIB = join(ROOT, "src/lib");
const OWN = ["owner-labels.ts", "owner-labels-fetch.ts", "owner-labels-store.ts"].map((f) => join(LIB, f));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

/** Every module specifier a file names: imports, re-exports and dynamic imports; `typeOnly` ones are flagged. */
function specifiers(file: string): { spec: string; typeOnly: boolean }[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: { spec: string; typeOnly: boolean }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) out.push({ spec: n.moduleSpecifier.text, typeOnly: !!n.importClause?.isTypeOnly });
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push({ spec: n.moduleSpecifier.text, typeOnly: n.isTypeOnly });
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push({ spec: n.arguments[0].text, typeOnly: false });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = join(dirname(from), spec);
  else return null;
  for (const f of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (/\.(ts|tsx|json)$/.test(f) && existsSync(f)) return f;
  return null;
}

/** The import closure of `entry` within src/lib (as scripts/gen-engine.mjs walks it), type-only imports optional. */
function closure(entry: string, withTypes: boolean): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.endsWith(".json")) continue;
    for (const s of specifiers(f)) {
      if (s.typeOnly && !withTypes) continue;
      const r = resolve(f, s.spec);
      if (r && r.startsWith(LIB)) todo.push(r);
    }
  }
  return seen;
}

const importsOwnerLabels = (f: string) => specifiers(f).some((s) => /(?:^|\/)owner-labels(?:-fetch|-store)?$/.test(s.spec));

describe("the labeller is wired to nothing (DEC-0045 point 5)", () => {
  it("no file under src/app or src/components, and not the desk's cron run, imports an owner-labels module", () => {
    const scanned = [...files(join(ROOT, "src/app")), ...files(join(ROOT, "src/components")), join(LIB, "desk-run.ts")];
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.filter(importsOwnerLabels).map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("nothing else in src imports it either: only the three modules know each other", () => {
    const all = files(join(ROOT, "src")).filter((f) => !OWN.includes(f));
    expect(all.filter(importsOwnerLabels).map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("the scan sees an import when there is one", () => {
    const probe = join(LIB, "owner-labels-store.ts");
    expect(importsOwnerLabels(probe)).toBe(true);
  });

  it("no file of the shadow evaluation's engine (desk-eval.ts's closure, types included) is an owner-labels module", () => {
    const engine = closure(join(LIB, "desk-eval.ts"), true);
    expect(engine.has(join(LIB, "trade-state.ts"))).toBe(true);
    for (const f of OWN) expect(engine.has(f), relative(ROOT, f)).toBe(false);
  });

  it("the labeller's own closure never reaches the site's feed setting or the board's bars fetch", () => {
    for (const f of OWN) {
      const c = closure(f, false);
      for (const banned of ["alpaca-feed.ts", "bars.ts", "quote.ts", "desk-eval.ts", "snapshot.ts"]) expect(c.has(join(LIB, banned)), `${relative(ROOT, f)} reaches ${banned}`).toBe(false);
    }
    // the engine files reach the replay only as types: the release passes its frozen copy
    const values = closure(join(LIB, "owner-labels.ts"), false);
    for (const engineFile of ["trade-state.ts", "trade-now.ts", "entry-checks.ts", "focus-plan.ts"]) expect(values.has(join(LIB, engineFile)), engineFile).toBe(false);
  });
});
