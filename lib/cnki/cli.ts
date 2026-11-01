/** 知网命令注册：参数在这里声明并组装结果视图，请求与解析在 index.ts。 */
import path from "node:path";
import { command, sessionCommands, bool, type Command, type Flags } from "../core/command.ts";
import { ConfigError, RemoteRejected, ZjuError } from "../core/errors.ts";
import { beijingMinute, fileSize, log } from "../core/output.ts";
import { paths } from "../core/paths.ts";
import { currentTransport } from "../profile/profile.ts";
import { CORE, SORTS, TYPES, openCnki, paperRow, sessionStore, PaperSelectionRequired, type CoreKind, type DocType, type Query, type Sort } from "./index.ts";

/** 只控制请求节奏，不限制用户一次提交的篇数。 */
const BATCH_SIZE = 5;
const PAUSE_MS = 1000;
const BATCH_PAUSE_MS = 10_000;

const text = (f: Flags, key: string) => typeof f[key] === "string" ? (f[key] as string).trim() || undefined : undefined;
/** 多个值用竖线分隔，与其他模块相同。 */
const list = (value: string | undefined) => (value ?? "").split(/[|｜]/).map((v) => v.trim()).filter(Boolean);

/** 「2024」或「2020-2024」；只写起始年（2020-）时到今年。 */
function years(raw: string | undefined): [number, number] | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/\s|年/g, "").match(/^(\d{4})(?:[-–—~至到](\d{4})?)?$/);
  if (!m) throw new ConfigError("--year 写年份或范围，如 2024、2020-2024");
  const from = Number(m[1]), to = m[2] ? Number(m[2]) : raw.replace(/\s|年/g, "").length > 4 ? new Date().getFullYear() : from;
  if (from > to) throw new ConfigError("--year 的起始年份晚于结束年份");
  return [from, to];
}

const CORE_ALIASES: Record<string, CoreKind> = { 核心: "北大核心", 中文核心: "北大核心", 北核: "北大核心", 南大核心: "CSSCI", 南核: "CSSCI", c刊: "CSSCI" };
function core(raw: string | undefined): CoreKind[] | undefined {
  const kinds = list(raw).map((name) => {
    const kind = (Object.keys(CORE) as CoreKind[]).find((k) => k.toLowerCase() === name.toLowerCase()) ?? CORE_ALIASES[name.toLowerCase()];
    if (!kind) throw new ConfigError(`--core 须为 ${Object.keys(CORE).join(" / ")}，多个用竖线分隔`);
    return kind;
  });
  return kinds.length ? [...new Set(kinds)] : undefined;
}

export function createCnkiCommands(open: typeof openCnki = openCnki, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Record<string, Command> {
  return sessionCommands({
    search: command("在知网检索文献，可按类型、年份、核心期刊筛选：篇名、作者、来源、发表时间、被引和下载次数", {
      keyword: { description: "主题词；几个词用空格隔开，表示都要出现，如 图神经网络 推荐系统" },
      title: { description: "篇名里要有的词，写法同 keyword" },
      author: { description: "作者姓名" },
      source: { description: "来源：期刊名、学位授予单位或会议名，如 计算机学报、浙江大学" },
      type: { description: "文献类型，不写是全部", choices: Object.keys(TYPES) },
      year: { description: "发表年份或范围，如 2024、2020-2024" },
      core: { description: `期刊来源类别：${Object.keys(CORE).join("、")}，多个用竖线分隔，满足其一即可；只说“核心期刊”时写 北大核心|CSSCI|CSCD。给了它就只查期刊` },
      sort: { description: "排序：relevance 相关度、date 最新发表、cited 被引最多、downloads 下载最多", choices: Object.keys(SORTS), default: "relevance" },
      limit: { description: "条数", type: "integer", min: 1, max: 50, default: 20 },
    }, async (f) => {
      const kinds = core(text(f, "core")), type = text(f, "type") as DocType | undefined;
      if (kinds && type && type !== "期刊") throw new ConfigError("--core 只对期刊有效，不能与其他 --type 同用");
      const range = years(text(f, "year"));
      const query: Query = {
        ...(text(f, "keyword") ? { keyword: text(f, "keyword")! } : {}),
        ...(text(f, "title") ? { title: text(f, "title")! } : {}),
        ...(text(f, "author") ? { author: text(f, "author")! } : {}),
        ...(text(f, "source") ? { source: text(f, "source")! } : {}),
        ...(kinds ? { type: "期刊" as const, core: kinds } : type ? { type } : {}),
        ...(range ? { years: range } : {}),
        sort: f.sort as Sort, limit: Number(f.limit),
      };
      if (!query.keyword && !query.title && !query.author && !query.source) throw new ConfigError("需要 --keyword、--title、--author 或 --source 中的至少一个");
      const s = await open();
      try {
        const { total, papers } = await s.client.search(query);
        return { total, count: papers.length, papers: papers.map(paperRow) };
      } finally { s.close(); }
    }),
    download: command("按篇名下载文献全文 PDF；多篇一次传入，自动分批串行、复用已有文件并返回完整进度。默认存到 data/output/cnki/", {
      title: { description: "完整篇名，照检索结果里的写；多篇用竖线分隔，全部放进一次调用，不限篇数", required: true },
      author: { description: "作者姓名，有同名文献时用来区分" },
      source: { description: "来源（期刊名、学位授予单位或会议名），有同名文献时用来区分" },
      "out-dir": { description: "保存目录" },
    }, async (f) => {
      const titles = [...new Set(list(text(f, "title")))];
      if (!titles.length) throw new ConfigError("需要 --title 篇名");
      const by = { ...(text(f, "author") ? { author: text(f, "author")! } : {}), ...(text(f, "source") ? { source: text(f, "source")! } : {}) };
      const dir = path.resolve(text(f, "out-dir") ?? path.join(paths.output(), "cnki"));
      const s = await open();
      try {
        const files: unknown[] = [], failed: { title: string; error: unknown }[] = [];
        let stopped = false;
        let pending: string[] = [];
        for (const [i, title] of titles.entries()) {
          if (i) await wait(i % BATCH_SIZE === 0 ? BATCH_PAUSE_MS : PAUSE_MS);
          try {
            const paper = await s.client.find(title, by), saved = await s.client.save(paper, dir);
            files.push({ title: paper.title, authors: paper.authors.join("、"), source: paper.source, date: paper.date, path: saved.path, size: fileSize(saved.bytes), ...(saved.reused ? { reused: true } : {}), ...(saved.note ? { note: saved.note } : {}) });
            log(`知网：${i + 1}/${titles.length} ${paper.title}`);
          } catch (error) {
            // 单篇保留原来的错误与候选。多篇只跳过单篇问题；认证、验证、网络等共同故障停止整批。
            if (titles.length === 1) throw error;
            failed.push({ title, error });
            if (!(error instanceof PaperSelectionRequired || error instanceof RemoteRejected || error instanceof ConfigError)) {
              stopped = true;
              pending = titles.slice(i + 1);
              break;
            }
          }
        }
        const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
        const result = {
          status: stopped ? "stopped" : failed.length ? files.length ? "partial" : "failed" : "completed",
          message: `共 ${titles.length} 篇，已完成 ${files.length} 篇，失败 ${failed.length} 篇，未执行 ${pending.length} 篇。${stopped ? `本次已停止：${reason(failed.at(-1)!.error)}` : ""}`,
          requestedCount: titles.length, count: files.length, files,
          failed: failed.map(({ title, error }) => ({ title, reason: reason(error), ...(error instanceof ZjuError ? {
            code: error.code, ...(error.hint ? { hint: error.hint } : {}), ...(error.detail.candidates ? { candidates: error.detail.candidates } : {}),
          } : {}) })),
          pending,
        };
        if (!files.length) {
          const error = (stopped ? failed.at(-1) : failed[0])!.error;
          throw new ZjuError(error instanceof ZjuError ? error.code : "BAD_RESPONSE", result.message, { detail: result, ...(error instanceof ZjuError && error.hint ? { hint: error.hint } : {}) });
        }
        return result;
      } finally { s.close(); }
    }),
    login: command("用学校 IP 登录知网并保存登录，返回识别到的机构；有效期内直接复用", { fresh: { description: "强制重新登录", type: "boolean" } }, async (f) => {
      const s = await open();
      try {
        const r = await s.client.login(bool(f, "fresh"));
        return { institution: r.institution, reused: r.reused, expiresAt: beijingMinute(r.expiresAt), transport: s.client.ctx.transport, sessionFile: s.client.store.file };
      } finally { s.close(); }
    }),
    status: command("本地保存的知网登录（不联网）", {}, async () => {
      const store = sessionStore(currentTransport()), extra = store.load()?.extra as { institution?: string; expiresAt?: number } | undefined;
      const valid = typeof extra?.expiresAt === "number" && Date.now() < extra.expiresAt;
      return { file: store.file, loggedIn: valid, ...(valid ? { institution: extra!.institution, expiresAt: beijingMinute(extra!.expiresAt) } : {}) };
    }, "local"),
    logout: command("清除本地保存的知网登录", {}, async () => ({ cleared: sessionStore(currentTransport()).clear() }), "local"),
  }, "cnki");
}

export const cnkiCommands = createCnkiCommands();
