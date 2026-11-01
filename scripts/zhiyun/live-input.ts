/** Internal read-only RPC, not a model-facing command or execution mode. */
import { liveInput, type LiveInputRequest } from "../../lib/zhiyun/live-input.ts";
import { envelope, errorEnvelope, printAndExit } from "../../lib/core/output.ts";
try {
  const request = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")) as LiveInputRequest;
  const result = await liveInput(request);
  printAndExit(envelope("zhiyun", "live-input", result));
} catch (e) { printAndExit(errorEnvelope("zhiyun", "live-input", e), e); }
