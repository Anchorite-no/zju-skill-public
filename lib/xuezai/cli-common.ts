import { ConfigError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { fileJournal } from "../core/journal.ts";
import { bool, type Flags } from "../core/command.ts";
import { readProfile } from "../profile/profile.ts";
import { openXuezai, xuezaiSession, type Xuezai } from "./client.ts";
import type { Journal } from "./types.ts";

export async function withClient<T>(fn: (client: Xuezai) => Promise<T>, fresh = false): Promise<T> {
  const client = await openXuezai({ fresh });
  try { return await fn(client); } finally { client.close(); }
}

export function localSession() {
  const username = readProfile().zju_username;
  if (!username) throw new ConfigError("缺少 zju_username");
  return xuezaiSession(username);
}

/** 写闸在建立会话之前检查；通过后给出写前日志。 */
export function writeSetup(f: Flags, action: string): { confirm: true; journal: Journal; journalFile: string } {
  if (!bool(f, "confirm") || !writeAllowed()) throw new WriteGateClosed(action);
  const sink = fileJournal<Parameters<Journal>[0]>("xuezai");
  return { confirm: true, journalFile: sink.file, journal: sink.append };
}
