export interface ProfileVault {
  seal(text: string, purpose: string, previous?: unknown): unknown;
  open(sealed: unknown, purpose: string): string;
  forget(sealed: unknown): void;
}
interface Options {
  parseLegacy: (raw: string) => Record<string, string>;
  vault?: ProfileVault;
  expectedRaw?: string;
}
export function readProfileFile(file: string, options: Options): { raw: string; values: Record<string, string> };
export function writeProfileFile(file: string, values: Record<string, string>, options: Options): { raw: string; values: Record<string, string> };
