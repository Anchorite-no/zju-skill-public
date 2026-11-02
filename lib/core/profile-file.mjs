import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { credentialVault, isSealed } from './credential-vault.mjs'
import { atomicRename } from './atomic-rename.mjs'

const FORMAT = 'zju-profile-v1'
const PURPOSE = 'zju-profile'
const invalid = () => new Error('账号配置格式不正确；请使用 profile init 配置账号，不要直接编辑密文。')
function readRaw(file) {
  try { return fs.readFileSync(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('账号文件无法读取。') }
}
function values(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  if (Object.values(value).some(v => typeof v !== 'string')) throw invalid()
  return value
}
function decode(raw, vault, parseLegacy) {
  if (!raw.trim()) return { values: {} }
  if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
    let record
    try { record = JSON.parse(raw) } catch { throw invalid() }
    if (record?.format !== FORMAT || !isSealed(record.sealed)) throw invalid()
    let data
    try { data = JSON.parse(vault.open(record.sealed, PURPOSE)) }
    catch { throw new Error('账号密文无法解密，请解锁系统凭据库；不会回退到明文。') }
    return { values: values(data), sealed: record.sealed }
  }
  // A damaged encrypted document must never be mistaken for a legacy env file.
  if (raw.includes('"ciphertext"') || raw.includes('"sealed"')) throw invalid()
  const data = values(parseLegacy(raw))
  if (!Object.keys(data).length) throw invalid()
  return { values: data }
}
function locked(file, work) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = readRaw(lock), pid = Number(owner)
    let stale = false
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0) } catch (probe) { stale = probe.code === 'ESRCH' }
    } else stale = Date.now() - fs.statSync(lock).mtimeMs > 30000
    if (!stale || readRaw(lock) !== owner) throw new Error('账号正在被另一处保存，请稍后重试。')
    fs.unlinkSync(lock)
    fd = fs.openSync(lock, 'wx', 0o600)
  }
  try { fs.writeFileSync(fd, String(process.pid)); return work() }
  finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}
export function writeProfileFile(file, data, { expectedRaw, parseLegacy, vault = credentialVault }) {
  values(data)
  return locked(file, () => {
    const before = readRaw(file)
    if (expectedRaw !== undefined && expectedRaw !== before) throw new Error('账号已在别处改过，请重新读取后再保存。')
    const previous = decode(before, vault, parseLegacy).sealed
    const sealed = vault.seal(JSON.stringify(data), PURPOSE, previous)
    const raw = JSON.stringify({ format: FORMAT, sealed }, null, 2) + '\n'
    const temp = `${file}.${randomUUID()}.tmp`
    let written = false
    try {
      fs.writeFileSync(temp, raw, { flag: 'wx', mode: 0o600, flush: true })
      atomicRename(temp, file)
      written = true
      return { raw, values: data }
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
      if (!written && !previous) { try { vault.forget(sealed) } catch {} }
    }
  })
}
export function readProfileFile(file, { parseLegacy, vault = credentialVault }) {
  const raw = readRaw(file)
  const decoded = decode(raw, vault, parseLegacy)
  if (decoded.sealed || !raw.trim()) return { raw, values: decoded.values }
  return writeProfileFile(file, decoded.values, { expectedRaw: raw, parseLegacy, vault })
}
