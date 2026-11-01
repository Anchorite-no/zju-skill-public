import { ConfigError } from "./errors.ts";
import { commandHelp, type Command, type Flags } from "./command.ts";
export function exclusive(f: Flags, names: string[]): void {
    if (names.filter(name => f[name] !== undefined).length > 1)
        throw new ConfigError(`参数互斥：${names.map(n => `--${n}`).join(" / ")}`);
}
export function parseArgv(argv: string[]): {
    values: Flags;
    positionals: string[];
} {
    const values: Flags = {}, positionals: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--") {
            positionals.push(...argv.slice(i + 1));
            break;
        }
        if (arg === "-h") {
            values.help = true;
            continue;
        }
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const eq = arg.indexOf("="), name = arg.slice(2, eq > 2 ? eq : undefined);
        if (Object.hasOwn(values, name))
            throw new ConfigError(`--${name} 不可重复`);
        if (eq > 2)
            values[name] = arg.slice(eq + 1);
        else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") && argv[i + 1] !== "-h")
            values[name] = argv[++i];
        else
            values[name] = true;
    }
    return { values, positionals };
}
export function publicCommands(tree: Record<string, Command>, prefix: string): {
    path: string;
    command: Command;
}[] {
    // 有 options 的分组本身可执行，和它的子命令一起列出。
    return Object.entries(tree).flatMap(([name, command]) => command.hidden ? [] : [
        ...(command.children && !command.options ? [] : [{ path: `${prefix} ${name}`, command }]),
        ...(command.children ? publicCommands(command.children, `${prefix} ${name}`) : []),
    ]);
}
export function describeCommands(tree: Record<string, Command>, prefix: string, all = false): string[] {
    if (all)
        return publicCommands(tree, prefix).map(r => `  zju ${r.path}  ${r.command.help}`);
    return Object.entries(tree).filter(([, c]) => !c.hidden).map(([name, c]) => `  zju ${prefix} ${name}${c.children ? (c.options ? " [子命令]" : " <子命令>") : ""}  ${c.summary ?? c.help}`);
}
export function leafHelp(c: Command, route: string): string[] {
    return [`用法: zju ${route} ${c.help}`, "", ...commandHelp(c)];
}
