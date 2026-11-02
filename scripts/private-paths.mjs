import fs from 'node:fs'
import path from 'node:path'

export function isPrivatePath(name) {
  const parts = name.replaceAll('\\', '/').toLowerCase().split('/'), base = parts.at(-1)
  if (parts.some(part => ['.git', '.claude', '.codex', '.cursor', '.vscode', 'dev', 'plans', 'backup', 'data', 'downloads', 'out'].includes(part))) return true
  if (['agents.md', 'claude.md', 'development.md', '.npmrc', '.netrc', '.pypirc', 'id_rsa', 'id_ed25519'].includes(base)) return true
  if (/^(?:\.env|profile\.env)(?:\.|$)/.test(base) && !/(?:^|\.)example$/.test(base)) return true
  if (/^\.?(?:profile|accounts?|credentials?|secrets?|cookies?|sessions?|tokens?)\.(?:jsonl?|ya?ml|txt)(?:\..*)?$/.test(base)) return true
  return /\.local\.(?:json|ya?ml)$|\.(?:pem|key|p12|pfx|har|db(?:-.*)?|sqlite(?:3)?(?:-.*)?|tgz)$/.test(base)
}
export function assertPublicFiles(files) {
  const bad = files.filter(isPrivatePath)
  if (bad.length) throw new Error(`发布范围包含本机资料或凭据文件：\n${bad.join('\n')}`)
}
export function assertNoLinks(root, files) {
  for (const file of files) {
    let current = root
    for (const part of file.replaceAll('\\', '/').split('/')) {
      current = path.join(current, part)
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`发布路径不能包含符号链接：${file}`)
    }
  }
}
