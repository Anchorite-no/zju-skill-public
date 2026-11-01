import crypto from "node:crypto";
import { BadResponse, ConfigError } from "../core/errors.ts";

// Public protocol constants recovered in zju-run; no account secret is embedded.
const KEY = Buffer.from("ad8dad2869c5e017303e5f48858db3129bf4d07a47d85beaaaa9d26f436d232a", "hex");
const MASK = (1n << 64n) - 1n;

export function signingMaterial(token4: string): Buffer {
  const raw = Buffer.from(token4, "base64");
  if (raw.length !== 52 || raw.readUInt32BE(0) !== raw.length) throw new BadResponse("体艺签名令牌格式无效");
  const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, raw.subarray(4, 20));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(raw.subarray(20)), decipher.final()]);
}

export function canonicalize(path: string, query: string): string {
  if (!path.startsWith("/api/") || /[?#\r\n]/.test(path)) throw new ConfigError("体艺签名路径必须是 /api/ 相对路径");
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const parts = [...new URLSearchParams(query)].sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  return path + parts.map(([key, value]) => key + value).join("");
}

/** Query and POST form are signed after form decoding, including literal '+' handling. */
export function signRequest(material: Buffer, path: string, query = "", epochMs = Date.now()): { timestamp: string; sign: string } {
  if (material.length !== 32 || !Number.isSafeInteger(epochMs) || epochMs < 0) throw new ConfigError("体艺签名材料或时间无效");
  const ms = BigInt(epochMs), time = Buffer.alloc(8);
  time.writeBigUInt64BE(ms);
  let mixed = ((ms ^ (ms >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  mixed = ((mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn) & MASK;
  mixed = (mixed ^ (mixed >> 31n)) & MASK;
  const hash = crypto.createHash("sha256").update(material).update(canonicalize(path, query)).update(time).update(Buffer.from(material).reverse()).digest("hex").split("");
  [12, 28, 36, 38, 58].forEach((position, i) => hash.splice(position, 0, "199st"[i]!));
  return { timestamp: String(mixed), sign: hash.join("") };
}
