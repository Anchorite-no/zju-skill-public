import fs from 'node:fs'

/** Windows briefly denies replacement while another reader or scanner holds the target. */
export function atomicRename(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}
