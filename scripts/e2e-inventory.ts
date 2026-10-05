import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve("tsx"))("esbuild") as { transformSync(source: string, options: unknown): { code: string } };
const inventory: { file: string; names: string[] }[] = [];
for (const file of (await readdir("tests/e2e")).filter(f => f.endsWith(".test.ts")).sort()) {
  const source = (await readFile(join("tests/e2e", file), "utf8")).replace(/^import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?\s*/gm, "").replaceAll("import.meta.url", '"file:///inventory/test.ts"');
  const names: string[] = []; const test = Object.assign((name: string) => { names.push(name); }, { skip: (name: string) => { names.push(name); } });
  const context = createContext({ test, after: () => {}, before: () => {}, saveSuiteReport: () => {}, loadConfig: () => ({}), suiteDirectory: "inventory", join,
    process: { platform: "linux", cwd: () => process.cwd(), env: {}, execPath: process.execPath }, console: { log() {} }, URL, setTimeout, clearTimeout });
  new Script(transformSync(source, { loader: "ts", target: "esnext", format: "esm" }).code, { filename: file }).runInContext(context, { timeout: 1000 });
  inventory.push({ file, names });
}
const result = { registered: inventory.reduce((n, item) => n + item.names.length, 0), inventory };
const path = process.argv[2]; if (path) await writeFile(path, JSON.stringify(result, null, 2) + "\n"); else console.log(JSON.stringify(result, null, 2));
