import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionHost } from "../platform/host.js";
import { journalLines, seal, verifySeal } from "./journal.js";
import { SecretRedactor } from "../security.js";

export interface MemoryRecord { id: string; key: string; text: string; source: string; timestamp: number }
/** Host-managed memory: model/file data never writes it without explicit authorization. */
export class MemoryStore {
  constructor(readonly path: string, private readonly host: ExecutionHost, private readonly redactor = new SecretRedactor()) {}
  private async records(): Promise<{ records: MemoryRecord[]; checksum: string }> {
    let checksum = ""; const records: MemoryRecord[] = [];
    const lines = await journalLines(this.path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    for (const line of lines) { const record = JSON.parse(line) as MemoryRecord; checksum = verifySeal(record as unknown as Record<string, unknown>, checksum);
      if (!record.id || !record.key || !record.source || typeof record.text !== "string") throw new Error("memory_record_invalid"); records.push(record); }
    return { records, checksum };
  }
  async remember(input: { key: string; text: string; source: string; authorized: true }): Promise<MemoryRecord> {
    if (input.authorized !== true || !input.key.trim() || !input.source.trim()) throw new Error("memory_authorization_required");
    const text = this.redactor.text(input.text); if (/-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password|secret)\s*[:=]/i.test(text)) throw new Error("memory_secret_rejected");
    await mkdir(dirname(this.path), { recursive: true }); const lease = await this.host.acquire(this.path + ".lease");
    try { const { checksum } = await this.records(); const record = seal({ id: randomUUID(), key: input.key, text, source: input.source, timestamp: Date.now() }, checksum);
      const file = await open(this.path, "a", 0o600); try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); } finally { await file.close(); } return record;
    } finally { await lease.close(); }
  }
  async recall(query: string, limit = 10): Promise<MemoryRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("memory_limit_invalid");
    const latest = new Map<string, MemoryRecord>(); for (const record of (await this.records()).records) latest.set(record.key, record);
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return [...latest.values()].filter(r => terms.every(t => `${r.key} ${r.text}`.toLocaleLowerCase().includes(t))).slice(-limit).reverse();
  }
}
