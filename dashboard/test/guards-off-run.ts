// What the all-switches-off proof compares (guards-off.test.ts): for one board input, the board's rows (the engine's
// output) and the "Trade now" board drawn from them (the page); for one slot, the server's evaluation and the engine's
// fields of its record (all but `engine`, the label, which changes with any engine file by design). Each is
// serialised with every key in its place and an undefined value written out, then hashed.
//
// It uses only what the code before the guards already had, so the same file was run on origin/integration (0396e7e)
// to write the pinned hashes in guards-off.golden.json.
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TradeNowBoard } from "@/components/client/trade-now";
import { evaluateSlot, type EvalInput, serverRecord } from "@/lib/desk-eval";
import { type BoardInput, boardMode, boardRows } from "@/lib/trade-now";

/** JSON with an undefined value written out, so a key added as undefined still shows. */
export const serialise = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x === undefined ? "<undefined>" : x));
export const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function runBoard(input: BoardInput, live: boolean): { rows: string; html: string } {
  const rows = boardRows(input, live);
  const mode = boardMode(input.session, input.halfDay, "ok", input.now);
  const states = rows.map((r) => r.state).filter((s) => s !== null);
  const paused = mode.kind === "live" && states.length > 0 && states.every((s) => s.state === "paused");
  const html = renderToStaticMarkup(createElement(TradeNowBoard, { mode, rows, now: input.now, paused, onOpen: () => undefined }));
  return { rows: hash(serialise(rows)), html: hash(html) };
}

export function runEval(input: EvalInput, evaluatedAt: number): string {
  const ev = evaluateSlot(input);
  const { engine: _engine, ...record } = serverRecord(ev, input.slot, evaluatedAt, input.edition);
  void _engine;
  return hash(serialise({ ev, record }));
}
