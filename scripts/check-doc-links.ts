import { readFile, readdir, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

const texts = new Map<string, string>();
async function markdown(path: string): Promise<string> {
  const key = resolve(path);
  if (!texts.has(key)) {
    const text = await readFile(key, "utf8");
    if ((text.match(/^```/gm)?.length ?? 0) % 2) throw new Error(`未闭合代码围栏：${path}`);
    texts.set(key, text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*(?:\n|$)/gm, ""));
  }
  return texts.get(key)!;
}

function anchors(text: string): Set<string> {
  const result = new Set([...text.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]!));
  const repeats = new Map<string, number>();
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1]!.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/\s+#+\s*$/, "");
    const slug = heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "").replace(/\s/g, "-");
    const count = repeats.get(slug) ?? 0; repeats.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
}

const files = ["README.md", "AGENTS.md", ...await markdownFiles("docs")];
let checked = 0; let checkedAnchors = 0;
for (const file of files) {
  for (const match of (await markdown(file)).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]!.replace(/^<|>$/g, "");
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const separator = target.indexOf("#");
    const path = separator < 0 ? target : target.slice(0, separator);
    const fragment = separator < 0 ? "" : decodeURIComponent(target.slice(separator + 1));
    const destination = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
    await access(destination).catch(() => { throw new Error(`失效链接：${file} -> ${target}`); }); checked++;
    if (fragment && destination.endsWith(".md")) {
      if (!anchors(await markdown(destination)).has(fragment)) throw new Error(`失效锚点：${file} -> ${target}`);
      checkedAnchors++;
    }
  }
}
console.log(JSON.stringify({ files: files.length, checkedLinks: checked, checkedAnchors, passed: true }));
