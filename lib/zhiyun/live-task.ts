import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { BadResponse, ConfigError } from "../core/errors.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import { profilePath } from "../profile/profile.ts";
import { openZhiyun } from "./client.ts";
import { beijingDate, beijingTime, dayLessons, lessonDirectory, liveAddress, liveRoot, LiveTranscript, matchLiveCourse, parseLiveTime, queryLiveText, type LiveLesson, type LiveState } from "./live.ts";
import { receiveSubtitles } from "./live-socket.ts";

interface LiveTask {
  version: 1; id: string; pid: number; status: "starting" | "running" | "completed" | "stopped" | "failed";
  createdAt: number; updatedAt: number; lessons: LiveLesson[]; error: string | null; scope: string;
  until?: number;
}
const taskFile = () => path.join(liveRoot(), "task.json");
const leaseDir = () => path.join(liveRoot(), "task.lock");
const ownerFile = () => path.join(leaseDir(), "owner.json");
const stopFile = () => path.join(liveRoot(), "stop.json");
const processAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) {
    // Windows SSH/WMI may launch at a different integrity level. EPERM proves neither exit nor a stale lease.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const active = (task: LiveTask) => ["starting", "running"].includes(task.status);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function liveWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true });
  });
}

function releaseLease(id: string) {
  const owner = readJson<{ id: string }>(ownerFile());
  if (owner?.id !== id) return;
  fs.unlinkSync(ownerFile()); fs.rmdirSync(leaseDir());
}

function claimLease(id: string): boolean {
  fs.mkdirSync(liveRoot(), { recursive: true });
  try { fs.mkdirSync(leaseDir()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Serialize stale-lease recovery too: two starters must not remove a newly acquired lease.
    const recovery = path.join(liveRoot(), "recover.lock");
    try { fs.mkdirSync(recovery); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
    try {
      const owner = readJson<{ id: string; pid: number; createdAt: number }>(ownerFile());
      if (owner && (typeof owner.id !== "string" || !owner.id || !Number.isSafeInteger(owner.pid) || owner.pid < 1)) throw new ConfigError("字幕采集租约内容损坏，未覆盖可能仍在运行的任务");
      if (owner && processAlive(owner.pid)) return false;
      if (!owner) {
        if (Date.now() - fs.statSync(leaseDir()).mtimeMs < 30000) return false;
        // rmdir removes only an empty orphan; malformed owner files are never silently deleted.
        fs.rmdirSync(leaseDir());
      } else releaseLease(owner.id);
      try { fs.mkdirSync(leaseDir()); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
      writeJson(ownerFile(), { id, pid: process.pid, createdAt: Date.now() }); return true;
    } finally { fs.rmdirSync(recovery); }
  }
  writeJson(ownerFile(), { id, pid: process.pid, createdAt: Date.now() }); return true;
}

export function liveStatus() {
  const task = readJson<LiveTask>(taskFile()), now = Date.now();
  if (!task && fs.existsSync(taskFile())) throw new BadResponse("字幕任务状态文件损坏，无法确认是否运行");
  if (!task) return { status: "not-running", message: "尚未启动当天实时字幕采集。", courses: [] };
  const healthy = active(task) && processAlive(task.pid) && now - task.updatedAt < 20000;
  const status = active(task) && !healthy ? "unavailable" : task.status;
  const courses = task.lessons.map(l => {
    const directory = lessonDirectory(l), state = readJson<LiveState>(path.join(directory, "status.json"));
    let courseStatus: string = state?.status ?? "waiting";
    if (!healthy && ["waiting", "connected", "reconnecting"].includes(courseStatus)) courseStatus = status === "stopped" ? "stopped" : status === "completed" ? "ended" : "unavailable";
    return { course: l.title, startsAt: beijingTime(l.startsAt), endsAt: beijingTime(l.endsAt), room: l.room,
      status: courseStatus, sentences: state?.count ?? 0,
      newSentences: Math.max(0, (state?.count ?? 0) - (state?.initialCount ?? state?.count ?? 0)),
      lastCaptionAt: state?.lastCaptionAt ? beijingTime(state.lastCaptionAt) : null,
      lastActivityAt: state?.lastActivityAt ? beijingTime(state.lastActivityAt) : null,
      preview: state?.latest?.text ?? null, error: state?.error ?? null, directory };
  });
  const count = courses.reduce((n, c) => n + c.sentences, 0);
  const added = courses.reduce((n, c) => n + c.newSentences, 0);
  const description = status === "running" ? `${added ? "正在按当天课次采集" : "采集任务已启动，等待新的课堂字幕"}，本次新增 ${added} 句，累计保存 ${count} 句。`
    : status === "starting" ? "采集进程正在启动，尚未确认开始接收字幕。"
    : status === "unavailable" ? "采集进程无响应或已退出，已保存文字仍可查询。"
    : status === "completed" ? `当天采集任务已结束，共保存 ${count} 句。`
    : status === "stopped" ? `采集已停止，共保存 ${count} 句。` : `采集失败：${task.error ?? "未知错误"}`;
  return { status, message: description, taskId: task.id, startedAt: beijingTime(task.createdAt), updatedAt: beijingTime(task.updatedAt), courses, error: task.error };
}

async function spawnCollector(id: string): Promise<number> {
  const script = path.join(paths.root, "scripts", "zhiyun", "live.ts");
  if (process.platform === "win32") {
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    const commandLine = [process.execPath, script, id, paths.data(), profilePath()].map(s => '"' + s.replaceAll('"', '\\"') + '"').join(" ");
    const command = `$ErrorActionPreference='Stop'; $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${quote(commandLine)};CurrentDirectory=${quote(paths.root)};ProcessStartupInformation=$startup}; if ($r.ReturnValue -ne 0) { throw 'Cannot create live collector' }; Write-Output $r.ProcessId`;
    const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, timeout: 20000 });
    const pid = Number(result.stdout.trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new ConfigError("后台字幕进程未返回有效 PID");
    return pid;
  }
  const child = spawn(process.execPath, [script, id, paths.data(), profilePath()], { cwd: paths.root, detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  if (!child.pid) throw new ConfigError("后台字幕进程创建失败");
  return child.pid;
}

export async function startLive(course?: string, internal: { id?: string; until?: number } = {}) {
  const id = internal.id ?? crypto.randomUUID();
  if (!claimLease(id)) {
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      const owner = readJson<{ id: string }>(ownerFile()), old = readJson<LiveTask>(taskFile());
      if (!fs.existsSync(leaseDir())) return startLive(course, internal);
      if (old && old.id === owner?.id) {
        if (old.scope !== (course ?? "")) throw new ConfigError("已有其他课程范围的采集任务，请先查看状态；需要更换范围时停止后再启动");
        if (old.status !== "starting") return { ...liveStatus(), reused: true };
      }
      await liveWait(200);
    }
    throw new ConfigError("另一次字幕任务启动尚未确认，未重复创建进程");
  }
  let handedOff = false;
  try {
    const client = await openZhiyun();
    let lessons: LiveLesson[];
    try { lessons = matchLiveCourse((await dayLessons(client)).filter(l => l.endsAt + 300000 > Date.now()), course); }
    finally { client.close(); }
    if (!lessons.length) return { status: "no-course", message: "今天没有尚可监听的本人智云课次，未启动后台任务。", courses: [] };
    const now = Date.now();
    const task: LiveTask = { version: 1, id, pid: process.pid, status: "starting", createdAt: now, updatedAt: now, lessons, error: null, scope: course ?? "" };
    if (internal.until !== undefined) task.until = internal.until;
    writeJson(taskFile(), task);
    const pid = await spawnCollector(id);
    handedOff = true;
    // The child, not the launcher, publishes running and owns the lease after initialization.
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const current = readJson<LiveTask>(taskFile());
      if (current?.id === id && current.status !== "starting") return { ...liveStatus(), reused: false };
      if (!processAlive(pid)) throw new ConfigError("后台字幕进程在确认启动前退出，请查看 live status");
      await liveWait(200);
    }
    writeJson(stopFile(), { id });
    throw new ConfigError("后台字幕进程未及时确认启动，已请求退出；请查看 live status");
  } catch (e) {
    const task = readJson<LiveTask>(taskFile());
    if (task?.id === id && !handedOff) writeJson(taskFile(), { ...task, status: "failed", updatedAt: Date.now(), error: errorText(e) });
    throw e;
  } finally { if (!handedOff) releaseLease(id); }
}

export async function stopLive() {
  const task = readJson<LiveTask>(taskFile());
  if (!task || !active(task)) return liveStatus();
  if (!processAlive(task.pid)) {
    writeJson(taskFile(), { ...task, status: "failed", error: "采集进程已退出", updatedAt: Date.now() }); releaseLease(task.id); return liveStatus();
  }
  writeJson(stopFile(), { id: task.id });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const latest = readJson<LiveTask>(taskFile());
    if (latest?.id !== task.id || !active(latest)) return liveStatus();
    await liveWait(200);
  }
  return { ...liveStatus(), status: "stop-pending", message: "已请求停止，进程尚未确认退出；没有强杀任何进程。" };
}

export async function liveText(opts: { course?: string; at?: string; before?: number; after?: number }) {
  const at = parseLiveTime(opts.at), before = opts.before ?? 300, after = opts.after ?? 0;
  if (![before, after].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 3600)) throw new ConfigError("文字窗口前后秒数须为 0..3600 的整数");
  const end = at + after * 1000;
  if (end > Date.now() + 3600_000) throw new ConfigError("文字窗口最多等待未来一小时");
  const query = () => queryLiveText({ at, before, after, ...(opts.course ? { course: opts.course } : {}) });
  let result = query();
  // Do not block for future text if no matching collector exists.
  if ((after > 0 || at > Date.now()) && result.status !== "unavailable" && liveStatus().status === "running") {
    const controller = new AbortController(), abort = () => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try {
      while (Date.now() < end + 10000 && !controller.signal.aborted && liveStatus().status === "running") await liveWait(Math.min(1000, end + 10000 - Date.now()), controller.signal);
      result = query();
      if (controller.signal.aborted) return { ...result, status: "cancelled", message: "窗口等待已取消；返回目前已保存的文字。" };
    } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
  }
  return result;
}

/** One lesson's read-only lifecycle; injected clock/transport keep deadline verification isolated. */
export async function collectLiveLesson(lesson: LiveLesson, store: LiveTranscript, opts: {
  signal: AbortSignal;
  address: () => Promise<{ address: string | null; ended: boolean }>;
  receive?: typeof receiveSubtitles; now?: () => number; wait?: typeof liveWait;
}) {
  const now = opts.now ?? Date.now, wait = opts.wait ?? liveWait, receive = opts.receive ?? receiveSubtitles;
  const deadline = lesson.endsAt + 300000;
  await wait(Math.max(0, lesson.startsAt - 300000 - now()), opts.signal);
  let errors = 0;
  while (!opts.signal.aborted && now() < deadline) {
    try {
      const { address, ended } = await opts.address();
      if (opts.signal.aborted || now() >= deadline || ended) break;
      if (!address) { store.state.status = "waiting"; store.save(true, now()); await wait(Math.min(10000, Math.max(0, deadline - now())), opts.signal); continue; }
      await receive(address, { signal: AbortSignal.any([opts.signal, AbortSignal.timeout(Math.max(1, deadline - now()))]),
        onConnected: () => store.connect(now()), onActivity: () => store.activity(now()), onCaption: (data, time) => { errors = 0; store.caption(data, time); } });
    } catch (e) {
      if (opts.signal.aborted) break;
      // Filesystem errors cannot be disguised as recoverable network failures.
      if ((e as NodeJS.ErrnoException).code && !["BAD_RESPONSE", "REMOTE_REJECTED", "TRANSPORT", "AUTH_EXPIRED", "NEEDS_USER"].includes(String((e as NodeJS.ErrnoException).code))) throw e;
      store.disconnect("reconnecting", errorText(e), now()); errors++;
      await wait(Math.min(30000, 1000 * 2 ** Math.min(errors, 5), Math.max(0, deadline - now())), opts.signal);
    }
  }
  store.disconnect(opts.signal.aborted ? "stopped" : "ended", null, now());
}

/** Internal runner, never a second public execution mode. */
export async function runLiveTask(id: string): Promise<void> {
  const task = readJson<LiveTask>(taskFile());
  if (!task || task.id !== id || task.status !== "starting" || readJson<{ id: string }>(ownerFile())?.id !== id) throw new ConfigError("字幕后台任务标识已失效");
  const controller = new AbortController(), abort = () => controller.abort();
  const stores = new Map<string, LiveTranscript>();
  let failure: unknown;
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const publish = () => {
    if (readJson<{ id: string }>(ownerFile())?.id !== id) { failure = new ConfigError("字幕任务所有权已改变"); abort(); return; }
    task.updatedAt = Date.now(); writeJson(taskFile(), task);
    for (const store of stores.values()) store.save();
    if (readJson<{ id: string }>(stopFile())?.id === id) abort();
    if (task.until !== undefined && Date.now() >= task.until) abort();
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let client: Awaited<ReturnType<typeof openZhiyun>> | undefined;
  try {
    writeJson(ownerFile(), { id, pid: process.pid, createdAt: task.createdAt });
    task.pid = process.pid;
    for (const lesson of task.lessons) stores.set(lesson.subId, new LiveTranscript(lesson, id));
    task.status = "running"; publish();
    timer = setInterval(() => { try { publish(); } catch (e) { failure = e; abort(); } }, 2000);
    client = await openZhiyun({ signal: controller.signal });
    const opened = client;
    const outcomes = await Promise.allSettled(task.lessons.map(async lesson => {
      const store = stores.get(lesson.subId)!;
      await collectLiveLesson(lesson, store, { signal: controller.signal, address: () => liveAddress(opened, lesson) });
    }).map((work, index) => work.catch(e => {
      failure ??= e; task.error = errorText(e);
      try { stores.get(task.lessons[index]!.subId)!.disconnect("failed", errorText(e)); } finally { abort(); }
      throw e;
    })));
    for (const result of outcomes) if (result.status === "rejected") failure ??= result.reason;
    task.status = failure ? "failed" : controller.signal.aborted ? "stopped" : "completed";
    task.error = failure ? errorText(failure) : null;
  } catch (e) {
    if (controller.signal.aborted && !failure) task.status = "stopped";
    else { failure = e; task.status = "failed"; task.error = errorText(e); }
  }
  finally {
    clearInterval(timer); controller.abort(); client?.close();
    for (const store of stores.values()) {
      if (!["ended", "stopped"].includes(store.state.status)) {
        try { store.disconnect(failure ? "failed" : "stopped", failure ? errorText(failure) : null); } catch { /* final task error still records failure */ }
      }
    }
    if (readJson<{ id: string }>(ownerFile())?.id === id) {
      task.updatedAt = Date.now(); writeJson(taskFile(), task); releaseLease(id);
    }
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
