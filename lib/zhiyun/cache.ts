import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

interface StoredFile { path: string; sha256: string; bytes: number }

interface Stage { key: string; files: StoredFile[]; result?: unknown }

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function validStage(stage: Stage | undefined, expected: string): Promise<boolean> {
  if (!stage || stage.key !== expected || !stage.files.length) return false;
  for (const file of stage.files) {
    try { if (!(await fs.stat(file.path)).isFile() || (await fs.stat(file.path)).size !== file.bytes || await sha256(file.path) !== file.sha256) return false; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  return true;
}
