/**
 * JSON 文件原子读写。写：tmp + fsync + rename，mode 0600（Windows 上退化为普通文件）。
 */
import fs from "node:fs";
import path from "node:path";

export function readJson<T = unknown>(file: string): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, "")) as T;
  } catch {
    // 损坏的文件视为不存在；调用方决定是否重建。
    return undefined;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(value, null, 2) + "\n";
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, text, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* 某些文件系统不支持 */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function removeFile(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export function exists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}
