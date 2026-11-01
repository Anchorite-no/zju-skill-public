import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "./paths.ts";
/** Durable JSONL sink; each module owns its event schema and recovery semantics. */
export function fileJournal<T = unknown>(system: string, destination?: string): {
    file: string;
    append: (event: T) => void;
} {
    const file = path.resolve(destination ?? path.join(paths.journal(), `${system}-${Date.now()}-${crypto.randomUUID()}.jsonl`));
    return { file, append: event => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600, flush: true });
        } };
}
