// Usage: node scripts/real-world.ts <repoDir> [commits=30]  → JSON on stdout
import { execFileSync } from "node:child_process";
import { diffFile, type Finding } from "../src/rules.ts";
import { scanProject } from "../src/scan.ts";
import { isWatched } from "../src/guard.ts";
import { SeoLedger } from "../src/ledger.ts";
import { loadConfig } from "../src/config.ts";
import { extractFacts } from "../src/extract.ts";
import { walk, NOISE_PATH } from "../src/fs.ts";

const dir = process.argv[2];
const N = Number(process.argv[3] ?? 30);
const git = (...a: string[]) => { try { return execFileSync("git", a, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const cfg = loadConfig(dir).config;

const scan = scanProject(dir, cfg);
const byRule: Record<string, number> = {};
for (const f of scan.findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
const seoFiles = walk(dir, []).filter((f) => isWatched(f) && extractFacts(f, "") !== undefined).length;

// replay: commits touching watched files
const shas = (git("log", `--max-count=400`, "--format=%H", "--no-merges") ?? "").split("\n").filter(Boolean);
const edits: { sha: string; file: string; findings: Finding[] }[] = [];
let commits = 0, filesDiffed = 0;
for (const sha of shas) {
  if (commits >= N) break;
  const ch = (git("diff-tree", "--no-commit-id", "--name-status", "-r", "-M", sha) ?? "").split("\n").filter(Boolean)
    .map((l) => l.split("\t")).filter((p) => p[0].startsWith("M") && isWatched(p[1]) && !NOISE_PATH.test(p[1]));
  if (!ch.length) continue;
  commits++;
  const ledger = new SeoLedger();
  for (const [, file] of ch) {
    const before = git("show", `${sha}~1:${file}`), after = git("show", `${sha}:${file}`);
    if (before === null || after === null) continue;
    filesDiffed++;
    const fs = ledger.observe(dir, file, after, diffFile(file, before, after, cfg));
    if (fs.length) edits.push({ sha: sha.slice(0, 8), file, findings: fs });
  }
}
console.log(JSON.stringify({ dir, files: scan.filesScanned, routes: scan.routes, scanFindings: scan.findings.length, byRule, commits, filesDiffed, edits, scanSample: scan.findings.slice(0, 400) }));
