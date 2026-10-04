import { Type, type Static, type TSchema } from "typebox";
import * as Value from "typebox/value";
import type { AgentTool, ToolContext, ToolResult } from "../contracts.js";
import type { LocalEnvironment } from "../environment/local.js";

function define<T extends TSchema>(options: {
  name: string;
  description: string;
  parameters: T;
  effect: AgentTool["effect"];
  replay: AgentTool["replay"];
  execute(args: Static<T>, context: ToolContext): Promise<ToolResult>;
}): AgentTool {
  return {
    ...options,
    parameters: options.parameters as Record<string, unknown>,
    validate(input) {
      if (!Value.Check(options.parameters, input)) throw new Error("参数与工具 schema 不匹配");
      return input;
    },
    execute: (args, context) => options.execute(args as Static<T>, context),
  };
}

export function createCodingTools(environment: LocalEnvironment): AgentTool[] {
  return [
    define({
      name: "read", effect: "read", replay: "safe",
      description: "Read a UTF-8 text file with line numbers, or list directory entries. Paths are relative to the workspace. Read before editing. Local secret files and Agent private data are inaccessible.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }, { additionalProperties: false }),
      execute: async (args, context) => ({
        text: await environment.read(args.path, args.offset ?? 1, args.limit ?? 200, context.signal), isError: false,
      }),
    }),
    define({
      name: "write", effect: "write", replay: "never",
      description: "Create or replace a text file in the workspace. Creates parent directories. Use edit for small changes to existing files.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }), content: Type.String({ maxLength: 2_000_000 }),
      }, { additionalProperties: false }),
      execute: async (args, context) => {
        await environment.write(args.path, args.content, context.signal);
        return { text: `已写入 ${args.path}（${args.content.length} 字符）`, isError: false };
      },
    }),
    define({
      name: "edit", effect: "write", replay: "never",
      description: "Replace exactly one occurrence of oldText with newText. oldText must match the file exactly, without read-tool line number prefixes. Read the file first; ambiguous matches fail.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }), oldText: Type.String({ minLength: 1 }), newText: Type.String(),
      }, { additionalProperties: false }),
      execute: async (args, context) => {
        await environment.edit(args.path, args.oldText, args.newText, context.signal);
        return { text: `已修改 ${args.path}（替换一处精确匹配）`, isError: false };
      },
    }),
    define({
      name: "shell", effect: "process", replay: "never",
      description: `Execute a command in the workspace. Default shell: ${environment.shell}. Use it for search, builds and tests. A nonzero exit is an error result. This runs with the host user's permissions.`,
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 20_000 }),
        shell: Type.Optional(Type.Union([Type.Literal("powershell"), Type.Literal("bash")])),
      }, { additionalProperties: false }),
      execute: async (args, context) => {
        await context.reportProgress("正在执行命令…");
        const result = await environment.run(args.command, args.shell ?? environment.shell, context.signal);
        return {
          text: `${result.output}\n[exitCode=${result.exitCode}${result.timedOut ? ", timeout" : ""}]`,
          isError: result.timedOut || result.exitCode !== 0,
          ...(result.timedOut ? { code: "tool_timeout" } : result.exitCode !== 0 ? { code: "nonzero_exit" } : {}),
        };
      },
    }),
  ];
}
