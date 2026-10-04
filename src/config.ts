import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export interface AgentConfig {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  thinking: "off" | "low" | "medium" | "high";
  maxTurns: number;
  maxOutputTokens?: number;
  requestTimeoutMs: number;
  toolTimeoutMs: number;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

export function loadConfig(): AgentConfig {
  // Read this application's configuration, not an arbitrary target workspace's .env.
  try {
    loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const apiKey = process.env.MIMO_API_KEY?.trim();
  if (!apiKey || apiKey === "replace_with_your_token_plan_key") {
    throw new Error("请在 .env 或环境变量中设置 MIMO_API_KEY");
  }
  const baseUrl = process.env.MIMO_BASE_URL ?? "https://token-plan-cn.xiaomimimo.com/v1";
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("MIMO_BASE_URL 必须是不含用户名和密码的 HTTP(S) URL");
  }
  const thinking = process.env.MIMO_THINKING ?? "low";
  if (!["off", "low", "medium", "high"].includes(thinking)) throw new Error("MIMO_THINKING 不合法");
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    modelId: process.env.MIMO_MODEL_ID ?? "mimo-v2.6-flash",
    thinking: thinking as AgentConfig["thinking"],
    maxTurns: positiveInteger("AGENT_MAX_TURNS", 20),
    maxOutputTokens: positiveInteger("MIMO_MAX_OUTPUT_TOKENS", 8192),
    requestTimeoutMs: positiveInteger("AGENT_REQUEST_TIMEOUT_MS", 120_000),
    toolTimeoutMs: positiveInteger("AGENT_TOOL_TIMEOUT_MS", 60_000),
  };
}
