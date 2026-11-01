import { ConfigError } from "./errors.ts";
export type Flags = Record<string, string | boolean | undefined>;
export interface Option {
    description: string;
    type?: "string" | "boolean" | "integer" | "number";
    required?: boolean;
    allowEmpty?: boolean;
    default?: string | boolean | number;
    choices?: readonly string[];
    min?: number;
    max?: number;
}
export interface Command {
    help: string;
    run(f: Flags, positional: string[]): Promise<unknown>;
    summary?: string;
    children?: Record<string, Command>;
    hidden?: boolean;
    source?: "local" | "live" | ((data: unknown) => "local" | "live" | "cache");
    replacement?: string;
    options?: Record<string, Option>;
}
export const str = (f: Flags, k: string) => f[k] as string;
export const bool = (f: Flags, k: string) => f[k] === true || f[k] === "true" || f[k] === "1";
export const num = (f: Flags, k: string) => Number(f[k]);
export function validateOptions(options: Record<string, Option>, input: Flags): Flags {
    const result: Flags = {};
    for (const name of Object.keys(input))
        if (!Object.hasOwn(options, name)) {
            throw new ConfigError(`不支持 --${name}，请查看当前命令的 --help`);
        }
    for (const [name, option] of Object.entries(options)) {
        const raw = input[name] ?? option.default;
        if (raw === undefined) {
            if (option.required)
                throw new ConfigError(`需要 --${name}`);
            continue;
        }
        if (option.type === "boolean") {
            if (![true, false, "true", "false", "1", "0"].some(v => v === raw))
                throw new ConfigError(`--${name} 须为开关或 true/false/1/0`);
            result[name] = raw === true || raw === "true" || raw === "1";
            continue;
        }
        if (typeof raw === "boolean" || (!option.allowEmpty && !String(raw).trim()))
            throw new ConfigError(`--${name} 需要取值`);
        const value = String(raw);
        if (option.type === "number" && (!Number.isFinite(Number(value)) || Number(value) < (option.min ?? -Infinity) || Number(value) > (option.max ?? Infinity)))
            throw new ConfigError(`--${name} 需要有效数字`);
        if (option.type === "integer" && (!Number.isSafeInteger(Number(value)) || Number(value) < (option.min ?? -Infinity) || Number(value) > (option.max ?? Infinity)))
            throw new ConfigError(`--${name} 须为 ${option.min ?? "不限"}..${option.max ?? "不限"} 的整数`);
        if (option.choices && !option.choices.includes(value))
            throw new ConfigError(`--${name} 须为 ${option.choices.join(" / ")}`);
        result[name] = value;
    }
    return result;
}
export function command(description: string, options: Record<string, Option>, run: (f: Flags) => Promise<unknown>, source: "local" | "live" = "live"): Command {
    const help = Object.entries(options).map(([name, o]) => {
        const arg = `--${name}${o.type === "boolean" ? "" : " " + (o.choices?.join("|") ?? (o.type === "integer" ? "N" : "VALUE"))}`;
        return o.required ? arg : `[${arg}]`;
    }).join(" ") + " " + description;
    return { help, options, source, run: async (f, positional) => {
            if (positional.length)
                throw new ConfigError(`不接受位置参数：${positional.join(" ")}`);
            return run(validateOptions(options, f));
        } };
}
/** 命令分组。给了 self 时分组本身也能执行：不带子命令就运行 self。 */
export function group(description: string, children: Record<string, Command>, self?: Command): Command {
    if (self)
        return { ...self, summary: description, children };
    return { help: description, children, run: async () => { throw new ConfigError(`请选择子命令：${Object.entries(children).filter(([, c]) => !c.hidden).map(([name]) => name).join(" / ")}`); } };
}
export function retired(replacement: string): Command {
    return { help: "迁移到 " + replacement, hidden: true, replacement, run: async () => { throw new ConfigError(`此入口已迁移，请使用 ${replacement}`); } };
}
export function commandHelp(c: Command): string[] {
    return Object.entries(c.options ?? {}).map(([name, o]) => `  --${name}  ${o.description}${o.required ? "；必填" : ""}${o.default === undefined ? "" : `；默认 ${o.default}`}${o.choices ? `；可选 ${o.choices.join(" / ")}` : ""}${o.type === "integer" ? `；范围 ${o.min ?? "不限"}..${o.max ?? "不限"}` : ""}`);
}
/** Read an optional numeric flag; platform-specific bounds belong to its command. */
export function numberFlag(f: Flags, name: string, fallback: number): number {
    if (f[name] === undefined) {
        if (Number.isNaN(fallback))
            throw new ConfigError(`缺少 --${name}`);
        return fallback;
    }
    const value = requiredString(f, name), result = Number(value);
    if (!Number.isFinite(result))
        throw new ConfigError(`--${name} 需要数字`);
    return result;
}
export function requiredString(f: Flags, name: string): string {
    const value = f[name];
    if (typeof value !== "string" || !value.trim())
        throw new ConfigError(`需要 --${name}`);
    return value;
}
/** Every module uses session subcommands; former flat entries only report migration. */
export function sessionCommands(commands: Record<string, Command>, system: string): Record<string, Command> {
    const entries: Record<string, Command> = {};
    for (const name of ["login", "status", "logout", "import-cookie"]) {
        const entry = commands[name];
        if (!entry)
            continue;
        if (name === "status" || name === "logout")
            entry.source = "local";
        entries[name] = entry;
        commands[name] = retired(`${system} session ${name}`);
    }
    commands.session = group("会话维护；业务命令自动认证", entries);
    return commands;
}
