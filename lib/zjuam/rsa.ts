/**
 * 统一身份认证用的"裸 RSA"：m^e mod n，无 padding，输出 hex 左补零到模长。
 * 这是 zjuam 前端 jsbn RSAKey.encrypt 的行为；不能用 node:crypto 的 PKCS1 padding。
 */
import { NeedsUser } from "../core/errors.ts";

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

export function encryptPassword(password: string, modulusHex: string, exponentHex: string): string {
  if (!password) throw new NeedsUser("密码为空");
  const n = BigInt("0x" + modulusHex);
  const m = BigInt("0x" + Buffer.from(password, "ascii").toString("hex"));
  if (m >= n) throw new NeedsUser("密码长度超过认证系统限制");
  const e = BigInt("0x" + exponentHex);
  return modPow(m, e, n).toString(16).padStart(Math.ceil(modulusHex.length / 2) * 2, "0");
}
