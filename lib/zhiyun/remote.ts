import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "../core/env.ts";
import { paths } from "../core/paths.ts";
import { parseArgv } from "../core/cli.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { sha256 } from "./cache.ts";
import { BadResponse, ConfigError, TransportError, ZjuError, exitCodeFor, type ErrorCode } from "../core/errors.ts";

interface RemoteRun { code: number; stdout: string; stderr: string }
interface Payload { ok: boolean; system: string; action: string; meta?: Record<string, unknown>; data?: Record<string, any>; error?: { code: string; message: string; detail?: Record<string, any> } }
interface Config { target: string; root: string; node: string; key: string; port: string; identity: string }
interface FileOrigin { remote: string; localHash: string; remoteHash: string }
interface OriginMap { version: 1; identity: string; files: Record<string, FileOrigin> }
const normalize = (s: string) => s.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/+$/, "");
const digest = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const ps = (s: string) => "'" + s.replaceAll("'", "''") + "'";
// sftp batch arguments: Windows drive paths need a leading "/" on the OpenSSH for Windows server ("D:/x" is read
// relative to the home directory); remote paths are globbed, so glob characters are escaped as well.
const remotePath = (p: string) => '"' + (/^[A-Za-z]:\//.test(p) ? "/" + p : p).replace(/["\\*?[\]]/g, "\\$&") + '"';
const localPath = (p: string) => '"' + p.replaceAll("\\", "/").replace(/["]/g, '\\"') + '"';
const INPUT_GONE = "ZJU_REMOTE_INPUT_GONE";
let cancelled = false;

export function remoteTarget(): string | undefined {
  if (process.env.ZJU_ZHIYUN_REMOTE_CHILD === "1") return undefined;
  return env("ZJU_ZHIYUN_REMOTE").trim() || undefined;
}
function configuration(): Config {
  const target = remoteTarget(), root = normalize(env("ZJU_ZHIYUN_REMOTE_ROOT").trim());
  if (!target || !/^[A-Za-z0-9_][A-Za-z0-9_.@:[\]-]*$/.test(target)) throw new ConfigError("ZJU_ZHIYUN_REMOTE 须为 SSH 别名或 user@host");
  if (!/^[A-Za-z]:\//.test(root) || /[\r\n\x00]/.test(root)) throw new ConfigError("ZJU_ZHIYUN_REMOTE_ROOT 须为执行机上的 Windows 仓库绝对路径");
  const node = env("ZJU_ZHIYUN_REMOTE_NODE", "node"), key = env("ZJU_ZHIYUN_REMOTE_KEY").trim();
  const port = env("ZJU_ZHIYUN_REMOTE_PORT", "22");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new ConfigError("远程 SSH 端口无效");
  return { target, root, node, key, port, identity: digest(JSON.stringify([target, port, root])) };
}
function connection(c: Config, sftp = false): string[] {
  return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=3", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", sftp ? "-P" : "-p", c.port, ...(c.key ? ["-i", c.key] : [])];
}
/** `echo` forwards the child's stderr as it arrives (worker progress); file transfers keep theirs for the error detail only. */
async function run(executable: string, args: string[], signal?: AbortSignal, echo = true): Promise<RemoteRun> {
  if (signal?.aborted) throw new TransportError("远程智云执行已取消");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let size = 0, stderr = "", failure: Error | undefined;
    const stop = () => { cancelled = true; failure ??= new TransportError("远程智云执行已取消；未自动重试"); child.kill(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => { failure = new TransportError("远程智云执行超时；未自动重试"); child.kill(); }, 24 * 3600_000);
    const cleanup = () => { clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); signal?.removeEventListener("abort", stop); };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { failure = new BadResponse("远程智云 JSON 超过 32 MiB"); child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-3000); if (echo) process.stderr.write(chunk); });
    child.once("error", error => { cleanup(); reject(new TransportError("无法启动远程智云传输", { executable }, error)); });
    child.once("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code === 255 || code === null) reject(new TransportError("远程智云 SSH 连接失败", { stderr, exitCode: code }));
      else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""), stderr });
    });
  });
}

/** Run one repository script with node on the worker, inside its checkout, through the configured SSH route. */
function runWorkerScript(c: Config, script: string, args: string[], checks: string[] = [], signal?: AbortSignal): Promise<RemoteRun> {
  const command = ["$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)", "$OutputEncoding=[Console]::OutputEncoding",
    "$env:ZJU_ZHIYUN_REMOTE_CHILD='1'", `Set-Location -LiteralPath ${ps(c.root)}`, ...checks,
    `& ${ps(c.node)} ${script} ${args.map(ps).join(" ")}`, "exit $LASTEXITCODE"].join("; ");
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return run("ssh", [...connection(c), c.target, `powershell.exe -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encoded}`], signal);
}

function parsePayload(text: string, code: number): Payload {
  let p: Payload;
  try { p = JSON.parse(text); } catch { throw new BadResponse("远程智云未返回有效 JSON", { exitCode: code }); }
  if (!p || typeof p.ok !== "boolean" || p.system !== "zhiyun" || (code === 0) !== p.ok) throw new BadResponse("远程智云退出码与结果不一致", { exitCode: code });
  return p;
}
/**
 * One sftp batch command, retried up to 4 times so a dropped link continues from the partial file.
 * Downloads always use `get -a`: it creates a missing file and is a no-op on a complete one.
 * Uploads start with a plain `put`; retries resume with `put -a`, which fails with "stat remote" when the remote file
 * was never created (start over) and with "same size or larger" when the last attempt had in fact finished.
 * The worker still checks the input's SHA-256 before using it.
 * `prelude` lines run before the command on every attempt; a leading "-" ignores their failure (mkdir of an existing directory).
 */
async function sftp(c: Config, command: string, prelude: string[] = []): Promise<void> {
  const batch = path.join(paths.cache(), "zhiyun-remote", `sftp-${crypto.randomUUID()}.txt`);
  const upload = command.startsWith("put "), resume = command.replace(/^put /, "put -a ");
  await fsp.mkdir(path.dirname(batch), { recursive: true });
  let line = command;
  try {
    for (let attempt = 1; ; attempt++) {
      await fsp.writeFile(batch, [...prelude, line].join("\n") + "\n");
      let result: RemoteRun | undefined;
      try { result = await run("sftp", [...connection(c, true), "-q", "-b", batch, c.target], undefined, false); }
      catch (error) { if (cancelled || attempt >= 4) throw error; }
      if (result?.code === 0) return;
      if (upload && result && /same size or larger/.test(result.stderr)) return;
      if (upload) line = result && /stat remote/.test(result.stderr) ? command : resume;
      if (attempt >= 4) throw new TransportError("智云文件传输失败", { exitCode: result?.code, attempts: attempt, stderr: result?.stderr.slice(-500) });
    }
  } finally { await fsp.rm(batch, { force: true }); }
}
function convert(value: unknown, mappings: Map<string, string>): any {
  if (typeof value === "string") {
    for (const [remote, local] of [...mappings].sort((a, b) => b[0].length - a[0].length)) {
      const normalized = normalize(value), prefix = normalize(remote);
      if (normalized.toLowerCase() === prefix.toLowerCase()) return local;
      if (normalized.toLowerCase().startsWith(prefix.toLowerCase() + "/")) return path.join(local, normalized.slice(prefix.length + 1));
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(v => convert(v, mappings));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v, mappings)]));
  return value;
}
async function filesIn(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new BadResponse("智云产物不能包含符号链接");
    if (entry.isDirectory()) files.push(...await filesIn(name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

/** One remote CLI execution; SSH/SCP and path translation stay below the public CLI. */
export async function runRemoteZhiyun(argv: string[]): Promise<{ payload: Payload; code: number }> {
  const c = configuration(), { values, positionals } = parseArgv(argv);
  if (positionals[0] !== "zhiyun") throw new ConfigError("远程智云入口参数无效");
  const mapFile = path.join(paths.cache(), "zhiyun-remote", `${c.identity}.json`);
  const origins = readJson<OriginMap>(mapFile);
  const mappings = new Map<string, string>(), inputOrigins: Record<string, FileOrigin> = {}, checks: string[] = [];
  const flags = { ...values }, id = crypto.randomUUID();
  if (positionals[1] === "trans" && typeof flags["out-dir"] !== "string") {
    // The public task no longer requires an output directory; still allocate and
    // map one internally so worker artifacts are copied back to the caller.
    flags["out-dir"] = path.join(paths.output(), "zhiyun", `trans-${digest(String(flags.file ?? "")).slice(0, 16)}`);
  }
  // Caller files are uploaded once into the worker's input cache (data/cache/remote-input) and reused while the
  // hashes on both sides still match; files the worker returned earlier are reused in place. Linux caller paths
  // never reach Windows unchanged.
  const inputDir = `${c.root}/data/cache/remote-input`, inputs: { flag: string; input: string; hash: string }[] = [];
  for (const flag of ["file", "selection"]) {
    if (typeof flags[flag] !== "string") continue;
    const input = path.resolve(flags[flag]);
    if (!fs.existsSync(input)) {
      if (/^[A-Za-z]:[\\/]/.test(flags[flag])) continue;
      throw new ConfigError(`输入文件不存在：${input}`);
    }
    if (!(await fsp.stat(input)).isFile()) throw new ConfigError("智云输入须为普通文件");
    inputs.push({ flag, input, hash: await sha256(input) });
  }
  const stageInputs = async (reuse: boolean) => {
    const staged: string[] = [];
    for (const { flag, input, hash } of inputs) {
      const old = reuse && origins?.identity === c.identity ? origins.files[input] : undefined;
      let remote: string;
      if (old?.localHash === hash) {
        remote = old.remote;
        staged.push(`if (-not (Test-Path -LiteralPath ${ps(remote)}) -or (Get-FileHash -Algorithm SHA256 -LiteralPath ${ps(remote)}).Hash -ne ${ps(old.remoteHash)}) { [Console]::Out.Write('${INPUT_GONE}'); exit 3 }`);
      } else {
        remote = `${inputDir}/${hash}-${flag}${path.extname(input)}`;
        await sftp(c, `put ${localPath(input)} ${remotePath(remote)}`, [`-mkdir ${remotePath(inputDir)}`]);
        inputOrigins[input] = { remote, localHash: hash, remoteHash: hash };
        staged.push(`if ((Get-FileHash -Algorithm SHA256 -LiteralPath ${ps(remote)}).Hash -ne ${ps(hash)}) { throw 'Input transfer checksum mismatch' }`);
      }
      // Cached inputs in use are marked fresh, so the pruning below only removes ones unused for two weeks.
      if (remote.toLowerCase().startsWith(inputDir.toLowerCase() + "/")) staged.push(`(Get-Item -LiteralPath ${ps(remote)}).LastWriteTime = Get-Date`);
      flags[flag] = remote; mappings.set(remote, input);
    }
    staged.push(`Get-ChildItem -LiteralPath ${ps(inputDir)} -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue`);
    return staged;
  };
  checks.push(...await stageInputs(true));
  let destination: string | undefined, outputRemote: string | undefined;
  for (const flag of ["out-dir", "out"]) {
    if (typeof flags[flag] !== "string") continue;
    destination = path.resolve(flags[flag]);
    if (flag === "out" && fs.existsSync(destination)) throw new ConfigError(`输出文件已存在：${destination}`);
    outputRemote = `${c.root}/data/output/remote-${digest(destination).slice(0, 24)}${flag === "out" ? "-" + id + "/selection.json" : ""}`;
    flags[flag] = outputRemote;
  }
  const args = () => [...positionals, ...Object.entries(flags).flatMap(([k, v]) => v === undefined ? [] : [`--${k}=${v}`])];
  let result = await runWorkerScript(c, "scripts/zju.ts", args(), checks);
  // A cached input was pruned or altered on the worker: the check stops before the command starts, so upload again and run once more.
  if (result.code !== 0 && result.stdout.trim() === INPUT_GONE) result = await runWorkerScript(c, "scripts/zju.ts", args(), await stageInputs(false));
  const payload = parsePayload(result.stdout, result.code), data = payload.data;
  // OpenSSH's outer Windows PowerShell may collapse native nonzero exit codes to
  // 1. Recover the CLI contract from its structured business error, not that shell.
  const exitCode = payload.ok ? 0 : exitCodeFor(new ZjuError(payload.error?.code as ErrorCode, payload.error?.message ?? "远程智云执行失败"));
  const saveOrigins = (files: Record<string, FileOrigin>) => {
    const latest = readJson<OriginMap>(mapFile);
    writeJson(mapFile, { version: 1, identity: c.identity, files: { ...(latest?.identity === c.identity ? latest.files : {}), ...inputOrigins, ...files } } satisfies OriginMap);
  };
  // Transfer only business artifacts, never executable/model/session paths from
  // check/setup/session. Dry-run paths describe plans, not existing files.
  let artifact: string | undefined, directory = true;
  if (payload.ok && !data?.dryRun) {
    if (positionals[1] === "download") artifact = data?.outDir;
    else if (positionals[1] === "trans") artifact = outputRemote;
    else if (positionals[1] === "search" && typeof data?.saved === "string") { artifact = data.saved; directory = false; }
  }
  if (!artifact) {
    if (Object.keys(inputOrigins).length) saveOrigins({});
    if (outputRemote && destination) mappings.set(outputRemote, destination);
    const output = convert(payload, mappings) as Payload;
    output.meta = { ...output.meta, remoteWorker: c.target, returnedFiles: 0 };
    return { payload: output, code: exitCode };
  }
  artifact = normalize(artifact);
  if (!artifact.toLowerCase().startsWith(c.root.toLowerCase() + "/data/")) throw new BadResponse("远程智云产物不在工作目录 data 中");
  destination ??= path.join(paths.output(), "zhiyun", "remote", digest(c.identity + artifact).slice(0, 24));
  mappings.set(artifact, destination);
  const stage = path.join(paths.cache(), "zhiyun-remote", `transfer-${id}`);
  await fsp.mkdir(stage, { recursive: true });
  // A directory lands inside the existing stage as <stage>/<basename>, the same on every resumed attempt.
  const received = directory ? path.join(stage, path.posix.basename(artifact)) : path.join(stage, "received");
  const before = origins?.identity === c.identity ? origins.files : {};
  const updated: Record<string, FileOrigin> = {};
  try {
    await sftp(c, directory ? `get -aR ${remotePath(artifact)} ${localPath(stage)}` : `get -a ${remotePath(artifact)} ${localPath(received)}`);
    // Worker-local PPT inputs also need a caller-side original for Markdown links.
    let extraSource: { received: string; remote: string } | undefined;
    if (directory && typeof data?.source === "string" && convert(data.source, mappings) === data.source) {
      const remote = normalize(data.source);
      if (!/^[A-Za-z]:\//.test(remote)) throw new BadResponse("远程课件原件路径无效");
      const relative = path.join("source", path.win32.basename(remote));
      const receivedSource = path.join(received, relative);
      await fsp.mkdir(path.dirname(receivedSource), { recursive: true });
      await sftp(c, `get -a ${remotePath(remote)} ${localPath(receivedSource)}`);
      mappings.set(remote, path.join(destination, relative));
      extraSource = { received: receivedSource, remote };
    }
    const entries = directory ? await filesIn(received) : [received];
    for (const input of entries) {
      const relative: string = directory ? path.relative(received, input) : "";
      const local = directory ? path.join(destination, relative) : destination;
      const remote = input === extraSource?.received ? extraSource.remote : directory ? artifact + "/" + relative.replaceAll("\\", "/") : artifact;
      const remoteHash = await sha256(input);
      if (path.extname(local) === ".json") {
        const parsed = JSON.parse(await fsp.readFile(input, "utf8"));
        await fsp.writeFile(input, JSON.stringify(convert(parsed, mappings), null, 2) + "\n");
      } else if (path.extname(local) === ".md") {
        const body = await fsp.readFile(input, "utf8");
        const rewritten = body.replace(/(\]\()([^\r\n)]+)(\))/g, (whole, start: string, link: string, end: string) => {
          if (/^(?:https?:|#)/i.test(link)) return whole;
          let original: string;
          try { original = path.win32.resolve(path.win32.dirname(remote), decodeURIComponent(link)); } catch { return whole; }
          const replacement = convert(original, mappings) as string;
          if (replacement === original) return whole;
          return start + encodeURI(path.relative(path.dirname(local), replacement).replaceAll("\\", "/")).replaceAll("(", "%28").replaceAll(")", "%29") + end;
        });
        await fsp.writeFile(input, rewritten);
      }
      const localHash = await sha256(input);
      if (fs.existsSync(local)) {
        const existingHash = await sha256(local);
        if (existingHash !== localHash && existingHash !== before[local]?.localHash) throw new ConfigError(`回传目标有本地改动，保留原文件：${local}`);
      }
      updated[local] = { remote, remoteHash, localHash };
    }
    for (const input of entries) {
      const local = directory ? path.join(destination, path.relative(received, input)) : destination;
      await fsp.mkdir(path.dirname(local), { recursive: true });
      const partial = local + "." + id + ".partial";
      await fsp.copyFile(input, partial); await fsp.rename(partial, local);
    }
    saveOrigins(updated);
    const output = convert(payload, mappings) as Payload;
    output.meta = { ...output.meta, remoteWorker: c.target, returnedFiles: entries.length };
    return { payload: output, code: exitCode };
  } finally { await fsp.rm(stage, { recursive: true, force: true }); }
}
