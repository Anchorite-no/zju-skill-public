import { command, type Command, type Flags } from "../core/command.ts";
import { openEbook, searchEbooks } from "./index.ts";

const text = (f: Flags, key: string) => (typeof f[key] === "string" ? { [key]: f[key] } : {});

export const ebookCommands: Record<string, Command> = {
  search: command("学校订购的电子图书里有没有某本书（同时查图书馆电子书刊导航和超星电子书）：书名、作者、出版社、ISBN，以及有全文的平台和直达地址", {
    title: { description: "书名或书名里的词；与 --isbn 二选一" },
    isbn: { description: "ISBN，可以带连字符" },
    limit: { description: "条数", type: "integer", min: 1, max: 50, default: 10 },
  }, async (f) => {
    const e = await openEbook();
    try { return await searchEbooks(e, { limit: Number(f.limit), ...text(f, "title"), ...text(f, "isbn") }); } finally { e.close(); }
  }),
};
