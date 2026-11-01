/**
 * 路径约定。所有可变数据都在 DATA_DIR 下，默认 <repo>/data，可用 ZJU_DATA_DIR 覆盖。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function dataDir(): string {
  const override = process.env["ZJU_DATA_DIR"];
  return override && override.trim() ? path.resolve(override) : path.join(ROOT, "data");
}

export const paths = {
  root: ROOT,
  data: dataDir,
  sessions: () => path.join(dataDir(), "sessions"),
  session: (system: string) => path.join(dataDir(), "sessions", `${system}.json`),
  journal: () => path.join(dataDir(), "journal"),
  output: () => path.join(dataDir(), "output"),
  raw: () => path.join(dataDir(), "raw"),
  cache: () => path.join(dataDir(), "cache"),
  db: () => path.join(dataDir(), "zju.db"),
  envFile: () => path.join(ROOT, ".env"),
} as const;
