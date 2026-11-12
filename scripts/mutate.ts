// Usage: node scripts/mutate.ts <repoDir> — delete title/description/jsonld/noindex-adds on real pages, count detections
import { diffFile } from "../src/rules.ts";
import { walk } from "../src/fs.ts";
import { fileToRoute } from "../src/routes.ts";
import { readFileSync } from "node:fs";
const dir = process.argv[2];
let pages = 0, withTitle = 0, caught = 0; const missed: string[] = [];
for (const f of walk(dir, [])) {
  if (!fileToRoute(f) || !/\.(tsx|jsx|astro|vue|svelte|mdx?|html)$/.test(f)) continue;
  pages++;
  const src = readFileSync(`${dir}/${f}`, "utf8");
  const mut = src.replace(/<title>[\s\S]*?<\/title>/, "").replace(/(\btitle\s*:\s*)(['"`]).*?\2\s*,?/, "").replace(/^(\s*title\s*:).*$/m, "").replace(/(\btitle=)(\{[^}]*\}|"[^"]*")/, "");
  if (mut === src) continue;
  withTitle++;
  if (diffFile(f, src, mut, { ignore: [], rules: {} }).some((x) => x.rule === "title-removed")) caught++; else missed.push(f);
}
console.log(JSON.stringify({ dir, pages, mutated: withTitle, caught, missed: missed.slice(0, 5) }));
