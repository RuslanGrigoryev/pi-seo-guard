import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { matchesAny } from "./glob.ts";

export const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".astro", ".output", "dist", "build", ".vercel", ".netlify", "coverage", ".turbo", ".cache", "out"]);

export const toPosix = (p: string) => p.split(sep).join("/");
export const rel = (cwd: string, abs: string) => toPosix(relative(cwd, abs));

/** Tests, fixtures, stories, e2e: never real pages. */
export const NOISE_PATH = /(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures?|e2e|cypress|stories|\.storybook)\/|\.(?:test|spec|stories)\.[a-z]+$/i;

export function walk(cwd: string, ignore: string[], limit = 20000): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      const abs = join(dir, e.name);
      const r = rel(cwd, abs);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !matchesAny(ignore, r)) rec(abs); }
      else if (e.isFile() && !matchesAny(ignore, r) && !NOISE_PATH.test(r)) out.push(r);
    }
  };
  rec(cwd);
  return out;
}

export const readText = (abs: string): string | null => {
  try { if (statSync(abs).size > 2_000_000) return null; return readFileSync(abs, "utf8"); } catch { return null; }
};

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 }); } catch { return null; }
}
export const gitHeadFiles = (cwd: string): string[] | null => {
  const o = git(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]);
  return o === null ? null : o.split("\n").filter(Boolean);
};
export const gitShowHead = (cwd: string, rel_: string): string | null => git(cwd, ["show", `HEAD:${rel_}`]);
