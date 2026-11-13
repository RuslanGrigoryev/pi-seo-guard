// Usage: node scripts/mutate.ts <repoDir> — delete title/description/jsonld/noindex-adds on real pages, count detections
// Two mutators: "literal" (delete the first literal title) and "indirect" (blank the initialiser of a `const title/seoTitle = …`).
import { diffFile } from "../src/rules.ts";
import { walk } from "../src/fs.ts";
import { fileToRoute } from "../src/routes.ts";
import { diskReader } from "../src/resolve.ts";
import { readFileSync } from "node:fs";
const dir = process.argv[2];
const reader = diskReader(dir);
const cfg = { ignore: [], rules: {} };
const lit = { mutated: 0, caught: 0, missed: [] as string[] };
const ind = { mutated: 0, caught: 0, missed: [] as string[] };
let pages = 0;
const check = (f: string, src: string, mut: string, r: typeof lit) => {
  if (mut === src) return;
  r.mutated++;
  if (diffFile(f, src, mut, cfg, { after: reader }).some((x) => x.rule === "title-removed")) r.caught++; else r.missed.push(f);
};
for (const f of walk(dir, [])) {
  if (!fileToRoute(f) || !/\.(tsx|jsx|astro|vue|svelte|mdx?|html)$/.test(f)) continue;
  pages++;
  const src = readFileSync(`${dir}/${f}`, "utf8");
  check(f, src, src.replace(/<title>[\s\S]*?<\/title>/, "").replace(/(\btitle\s*:\s*)(['"`]).*?\2\s*,?/, "").replace(/^(\s*title\s*:).*$/m, "").replace(/(\btitle=)(\{[^}]*\}|"[^"]*")/, ""), lit);
  check(f, src, src.replace(/(\bconst\s+(?:seoT|t)itle\s*(?::[^=\n]+)?=\s*)[^\n;]+/, "$1''"), ind);
}
console.log(JSON.stringify({ dir, pages, literal: { mutated: lit.mutated, caught: lit.caught, missed: lit.missed.slice(0, 4) }, indirect: { mutated: ind.mutated, caught: ind.caught, missed: ind.missed.slice(0, 4) } }));
