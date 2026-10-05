import { isAbsolute, posix } from "node:path";
import { isPrivatePath } from "../environment/local.js";
export type HistoryQuery = { path: string; start?: number; count?: number } | { entryId: string; attachment?: boolean; offset?: number; limit?: number };
export type HistoryPage = Record<string, unknown> & { sessionId: string; authority: "historical-data"; cursor: string | null };
export function normalizeHistoryPath(input: string): string {
  if (!input || input.length > 512 || isAbsolute(input) || input.includes("\\") || input.includes("\0")) throw new Error("history_path_invalid");
  const path = posix.normalize(input);
  if (path === ".." || path.startsWith("../") || path === "." || isPrivatePath(path)) throw new Error("history_path_invalid");
  return path;
}
