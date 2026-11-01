/**
 * 统一错误类型。所有模块只抛这些；CLI 据此决定退出码与 error.code。
 */

export type ErrorCode =
  | "NEEDS_USER" // 需要用户介入：密码错、验证码、未配置凭据
  | "AUTH_EXPIRED" // 登录态失效且自动重登失败
  | "RATE_LIMITED"
  | "REMOTE_REJECTED" // 远端返回了业务层拒绝
  | "TRANSPORT" // 网络层失败
  | "WRITE_GATE_CLOSED"
  | "DEPENDENCY_MISSING"
  | "BAD_RESPONSE" // 响应形状不符合预期
  | "CONFIG"; // 本地配置/参数错误

export class ZjuError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly detail: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts: { hint?: string; detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ZjuError";
    this.code = code;
    this.hint = opts.hint;
    this.detail = opts.detail ?? {};
  }
}

export class NeedsUser extends ZjuError {
  constructor(message: string, hint?: string) {
    super("NEEDS_USER", message, hint === undefined ? {} : { hint });
  }
}
export class AuthExpired extends ZjuError {
  constructor(system: string, message = `${system} 登录态失效`) {
    super("AUTH_EXPIRED", message, { detail: { system } });
  }
}
export class RateLimited extends ZjuError {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 1000) {
    super("RATE_LIMITED", message, { detail: { retryAfterMs } });
    this.retryAfterMs = retryAfterMs;
  }
}
export class RemoteRejected extends ZjuError {
  constructor(message: string, raw?: unknown) {
    super("REMOTE_REJECTED", message, { detail: { raw } });
  }
}
export class TransportError extends ZjuError {
  constructor(message: string, detail: Record<string, unknown> = {}, cause?: unknown) {
    super("TRANSPORT", message, { detail, cause });
  }
}
export class WriteGateClosed extends ZjuError {
  constructor(action: string) {
    super("WRITE_GATE_CLOSED", `写操作 ${action} 被拦截`, {
      hint: "需要同时设置环境变量 ZJU_ALLOW_WRITE=1 并在命令行加 --confirm",
    });
  }
}
export class BadResponse extends ZjuError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("BAD_RESPONSE", message, { detail });
  }
}
export class ConfigError extends ZjuError {
  constructor(message: string, hint?: string) {
    super("CONFIG", message, hint === undefined ? {} : { hint });
  }
}

/** 退出码约定见 SKILL.md：本地依赖缺失为 5。 */
export function exitCodeFor(err: unknown): number {
  if (!(err instanceof ZjuError)) return 1;
  switch (err.code) {
    case "NEEDS_USER":
    case "AUTH_EXPIRED":
      return 2;
    case "WRITE_GATE_CLOSED":
      return 3;
    case "TRANSPORT":
      return 4;
    case "DEPENDENCY_MISSING":
      return 5;
    default:
      return 1;
  }
}
