import { createHash, randomUUID } from "node:crypto";
import { open, readFile, copyFile, truncate } from "node:fs/promises";
export function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function seal<T extends object>(value: T, previousHash: string): T & { previousHash: string; checksum: string } {
  const unsigned = { ...value, previousHash };
  return { ...unsigned, checksum: digest(unsigned) };
}
export function verifySeal(value: Record<string, unknown>, previousHash: string): string {
  const { checksum, ...unsigned } = value;
  if (value.previousHash !== previousHash || typeof checksum !== "string" || checksum !== digest(unsigned)) throw new Error("journal_checksum_mismatch：日志前序或摘要不匹配");
  return checksum;
}
export async function journalLines(path: string, writable = false): Promise<string[]> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n");
  const tail = lines.at(-1)!;
  if (tail.trim()) {
    try { JSON.parse(tail); }
    catch (error) {
      const message = String(error);
      const at = /at position (\d+)/.exec(message);
      if (!/end of JSON|unterminated|end of data/i.test(message) && !(at && Number(at[1]) === tail.length)) throw new Error("journal_corrupt_tail：尾部并非明确的不完整记录", { cause: error });
      lines.pop();
      if (writable) { await copyFile(path, `${path}.tail-backup-${randomUUID()}`); await truncate(path, Buffer.byteLength(lines.join("\n") + "\n")); }
      return lines.filter(line => line.trim());
    }
    if (writable) { const handle = await open(path, "a"); try { await handle.writeFile("\n"); await handle.sync(); } finally { await handle.close(); } }
  }
  return lines.filter(line => line.trim());
}
