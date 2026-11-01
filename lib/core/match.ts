import { ConfigError, NeedsUser } from "./errors.ts";

const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** 一串说法按 | 、 ， ； 任一种分隔，去掉重复（不分大小写和全半角） */
export function splitPhrases(raw: string): string[] {
  const seen = new Set<string>();
  return raw.split(/[|｜、，,；;\n]+/).map((k) => k.trim()).filter((k) => k && !seen.has(normalize(k)) && seen.add(normalize(k)));
}

/** 简称按字序出现在全名里（计组 → 计算机组成，概统 → 概率论与数理统计）；至少两个字。 */
export function abbreviates(query: string, name: string): boolean {
  const q = [...query.normalize("NFKC").toLowerCase().replace(/\s+/g, "")], n = name.normalize("NFKC").toLowerCase();
  let at = 0;
  for (const ch of q) { at = n.indexOf(ch, at); if (at < 0) return false; at += ch.length; }
  return q.length > 1;
}

/** Resolve user-facing names, retaining ambiguity instead of choosing a first result. */
export function uniqueMatch<T>(rows: T[], query: string, names: (row: T) => string[], describe: (row: T) => unknown, label: string): T {
  const wanted = normalize(query);
  if (!wanted) throw new ConfigError(`需要${label}名称`);
  const exact = rows.filter(row => names(row).some(name => normalize(name) === wanted));
  const matches = exact.length ? exact : rows.filter(row => names(row).some(name => normalize(name).includes(wanted)));
  if (matches.length === 1) return matches[0]!;
  const error = new NeedsUser(matches.length ? `${label}不唯一，请从候选中明确目标` : `未找到${label}“${query}”`);
  error.detail.candidates = (matches.length ? matches : rows).slice(0, 12).map(describe);
  throw error;
}
