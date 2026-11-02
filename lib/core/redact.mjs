export const SECRET_KEYS = /pass(word|wd)?|secret|token|cookie|ticket|authorization|api[-_]?key|jsessionid|route/i
const FIELD = '(?:[\\w-]*(?:password|passwd|secret|token|cookie|ticket|authorization|api[-_]?key|jsessionid)[\\w-]*)'
const ASSIGNMENT = new RegExp(`(["']?${FIELD}["']?\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;&}\\]]+)`, 'gi')

/** Used only at diagnostic boundaries; never rewrites credentials before authentication. */
export function redactText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, match => {
      try {
        const url = new URL(match)
        if (url.username || url.password) { url.username = '<redacted>'; url.password = '' }
        for (const key of [...url.searchParams.keys()]) if (SECRET_KEYS.test(key)) url.searchParams.set(key, '<redacted>')
        return url.toString()
      } catch { return match }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/(^|\r?\n)((?:cookie|set-cookie|authorization)\s*:)\s*[^\r\n]*/gi, '$1$2 <redacted>')
    .replace(ASSIGNMENT, '$1<redacted>')
}

export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) && item !== null && item !== '' ? '<redacted>' : redact(item, depth + 1)]))
  return value
}
