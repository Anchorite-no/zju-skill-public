import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertPublicFiles } from './private-paths.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staged = process.argv.includes('--staged'), treeOnly = process.argv.includes('--tree-only')
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error('无法检查 Git 文件范围。')
  return result.stdout
}
assertPublicFiles(git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z']).split('\0').filter(Boolean))
if (treeOnly) { console.log('当前跟踪文件范围检查通过；未检查历史或密钥。'); process.exit(0) }
if (!staged) assertPublicFiles([...new Set(git(['log', '--all', '--format=', '--name-only', '-z']).split('\0').map(file => file.replace(/^\n+/, '')).filter(Boolean))])
const configured = spawnSync('git', ['config', '--local', '--get', 'security.gitleaksPath'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim()
const result = spawnSync(process.env.GITLEAKS_BIN || configured || 'gitleaks', ['git', root, '--no-banner', '--redact=100', ...(staged ? ['--pre-commit', '--staged'] : ['--log-opts=--all'])], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw new Error('请安装 Gitleaks 8.30.1，或设置 GITLEAKS_BIN。')
if (result.status !== 0) process.exitCode = result.status || 1
else console.log('凭据与发布范围检查通过。')
