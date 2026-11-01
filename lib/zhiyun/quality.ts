/** Heights come from real dimensions, never the portal's numeric quality slot. */
export function videoHeight(value: string): number | undefined {
  let text = value;
  try { text = decodeURIComponent(new URL(value).pathname); } catch { /* A label or resolution string. */ }
  const dimensions = [...text.matchAll(/(?:^|[_./\s-])(\d{2,5})[_x](\d{2,5})(?=[_./\s-]|$)/gi)];
  const height = dimensions.length ? Number(dimensions.at(-1)![2]) : Number(text.match(/(?:^|\D)(\d{3,4})p(?:\b|_)/i)?.[1]);
  return Number.isSafeInteger(height) && height > 0 ? height : undefined;
}

export function selectQuality<T extends { height?: number; bandwidth?: number }>(sources: T[], target: 1080 | 360): T | undefined {
  const exact = sources.find(s => s.height === target);
  if (exact) return exact;
  const known = sources.filter(s => s.height !== undefined && s.height > 0);
  return [...(known.length ? known : sources)].sort((a, b) => {
    const difference = known.length ? a.height! - b.height! : (a.bandwidth ?? 0) - (b.bandwidth ?? 0);
    return target === 360 ? difference : -difference;
  })[0];
}
