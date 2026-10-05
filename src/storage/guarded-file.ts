import { constants } from "node:fs";
import { open } from "node:fs/promises";
/** Bounded regular-file read; no final symlink and no growth-driven allocation. */
export async function readGuardedFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("bounded_file_invalid");
    const buffer = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("bounded_file_changed");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
