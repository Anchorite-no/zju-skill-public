import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertPublicFiles, assertNoLinks } from './private-paths.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.npm_execpath) throw new Error('请通过 npm pack 执行包检查。')
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true })
if (result.status !== 0) throw new Error('无法检查包文件清单。')
for (const pkg of JSON.parse(result.stdout)) {
  const files = pkg.files.map(file => file.path)
  assertPublicFiles(files)
  assertNoLinks(root, files)
  console.log(`发布范围检查通过：${files.length} 个文件。`)
}
