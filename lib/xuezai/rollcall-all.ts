/** Composition only: all business steps remain in the two standalone executors. */
import { signin, cancelledBeforeDeadline, type RollcallClient, type SigninOptions, type SigninResult } from "./rollcall.ts";
import { signinNumber } from "./rollcall-number.ts";
import { WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";

export async function signinAll(client: RollcallClient, opts: SigninOptions, executors = { gps: signin, number: signinNumber }) {
  if (!opts.confirm || !writeAllowed()) throw new WriteGateClosed("学在签到全开");
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  let winner: { kind: string; result: SigninResult } | undefined;
  // Executors report success before their own cleanup, so the sibling stops without waiting for it.
  const branches = await Promise.all(Object.entries(executors).map(async ([kind, execute]) => {
    const onSuccess = (result: SigninResult) => { if (!winner) { winner = { kind, result }; stop.abort(); opts.onSuccess?.(result); } };
    try { return { kind, ...await execute(client, { ...opts, signal, onSuccess }) }; }
    catch (e) { return { kind, status: "not-signed" as const, message: e instanceof Error ? e.message : String(e), polls: 0, answers: 0 }; }
  }));
  if (winner) return { ...winner.result, via: winner.kind, message: `${winner.result.message} GPS 与数字两路监测均已停止。`, branches };
  return { status: cancelledBeforeDeadline(opts.signal, false) ? "cancelled" as const : "not-signed" as const,
    message: branches.map(b => `${b.kind === "gps" ? "GPS" : "数字"}：${b.message}`).join("；"),
    polls: branches.reduce((n, b) => n + b.polls, 0), answers: branches.reduce((n, b) => n + b.answers, 0), branches };
}
