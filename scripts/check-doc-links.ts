import { readFile, readdir, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
const files = ["README.md", "AGENTS.md", ...(await readdir("docs")).filter(file => file.endsWith(".md")).map(file => join("docs", file))];
let checked = 0;
for (const file of files) {
  const content = await readFile(file, "utf8");
  if ((content.match(/^```/gm)?.length ?? 0) % 2) throw new Error(`未闭合代码围栏：${file}`);
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]!.replace(/^<|>$/g, "").split("#")[0]!;
    if (!target || /^[a-z]+:/i.test(target)) continue;
    await access(resolve(dirname(file), decodeURIComponent(target))).catch(() => { throw new Error(`失效链接：${file} -> ${target}`); }); checked++;
  }
}
console.log(JSON.stringify({ files: files.length, checkedLinks: checked, passed: true }));
