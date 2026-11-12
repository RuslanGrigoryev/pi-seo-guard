import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type SeoGuardConfig, severityOf } from "./config.ts";
import { matchesAny } from "./glob.ts";
import { type Finding, diffFile, isLayoutFile } from "./rules.ts";
import { extractFacts, kindOf } from "./extract.ts";
import { fileToRoute, isHomepage, isRedirectConfig, redirectCovers, redirectSources } from "./routes.ts";
import { rel, readText, walk, SKIP_DIRS } from "./fs.ts";

const WATCHED_NAMES = /^(?:robots\.txt|sitemap\.xml|vercel\.json|netlify\.toml|_redirects)$/;

export function isWatched(r: string): boolean {
  const base = r.split("/").pop() ?? "";
  return WATCHED_NAMES.test(base) || isRedirectConfig(r) || kindOf(r) !== null;
}

export interface ToolInput { path?: string; content?: string; edits?: { oldText: string; newText: string }[]; command?: string }

/** Apply pi's `edit` tool input to existing text (same semantics: exact, unique oldText match). Returns null if it can't be applied. */
export function applyEdits(before: string, edits: { oldText: string; newText: string }[]): string | null {
  let out = before;
  for (const e of edits) {
    const i = out.indexOf(e.oldText);
    if (i < 0 || out.indexOf(e.oldText, i + 1) >= 0) return null;
    out = out.slice(0, i) + e.newText + out.slice(i + e.oldText.length);
  }
  return out;
}

/** Pre-execution check for `edit` / `write`. */
export function checkWrite(cwd: string, toolName: "edit" | "write", input: ToolInput, cfg: SeoGuardConfig): Finding[] {
  if (!input.path) return [];
  const abs = isAbsolute(input.path) ? input.path : resolve(cwd, input.path.replace(/^@/, ""));
  const r = rel(cwd, abs);
  if (r.startsWith("..") || matchesAny(cfg.ignore, r) || r.split("/").some((s) => SKIP_DIRS.has(s)) || !isWatched(r)) return [];
  const before = existsSync(abs) ? readText(abs) : null;
  let after: string | null;
  if (toolName === "write") after = input.content ?? "";
  else {
    if (before === null || !input.edits) return [];
    after = applyEdits(before, input.edits);
  }
  if (after === null) return [];
  return diffFile(r, before, after, cfg);
}

// ---- bash: file deletion / rename ----

function tokenize(cmd: string): string[][] {
  const stmts: string[][] = [[]];
  const re = /"([^"]*)"|'([^']*)'|(&&|\|\||;|\n|\|)|([^\s;&|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    if (m[3]) stmts.push([]);
    else stmts[stmts.length - 1].push(m[1] ?? m[2] ?? m[4]);
  }
  return stmts.filter((s) => s.length);
}

/** Paths a bash command removes or moves away (rm / git rm / mv / git mv). Best-effort; no globs/subshells. */
export function removedPathsFromBash(cmd: string): string[] {
  const out: string[] = [];
  for (let s of tokenize(cmd)) {
    if (s[0] === "sudo") s = s.slice(1);
    let verb = s[0], args = s.slice(1);
    if (verb === "git" && (s[1] === "rm" || s[1] === "mv")) { verb = s[1]; args = s.slice(2); }
    if (verb !== "rm" && verb !== "mv" && verb !== "unlink") continue;
    const paths = args.filter((a) => !a.startsWith("-"));
    if (verb === "mv") paths.pop(); // destination
    out.push(...paths);
  }
  return out;
}

/** Route files that exist now under `target` (a file or directory, project-relative). */
function routeFilesUnder(cwd: string, target: string, ignore: string[]): string[] {
  const abs = resolve(cwd, target);
  const t = rel(cwd, abs);
  if (t.startsWith("..")) return [];
  if (fileToRoute(t)) return [t];
  if (!existsSync(abs)) return [];
  return walk(abs, []).map((f) => (t ? `${t}/${f}` : f)).filter((f) => fileToRoute(f) && !matchesAny(ignore, f));
}

export interface PendingRouteRemoval { file: string; route: string }

/** Pre-execution: which route files would this bash command remove/move? */
export function routeRemovalsFromBash(cwd: string, command: string, cfg: SeoGuardConfig): PendingRouteRemoval[] {
  const res: PendingRouteRemoval[] = [];
  for (const p of removedPathsFromBash(command)) {
    for (const f of routeFilesUnder(cwd, p, cfg.ignore)) {
      const info = fileToRoute(f)!;
      res.push({ file: f, route: info.route });
    }
  }
  return res;
}

/** Critical findings for removals (homepage). */
export function criticalRemovalFindings(removals: PendingRouteRemoval[], cfg: SeoGuardConfig): Finding[] {
  const sev = severityOf(cfg, "homepage-removed");
  if (sev === "off") return [];
  return removals.filter((r) => isHomepage(r.route)).map((r) => ({
    rule: "homepage-removed" as const, severity: sev, file: r.file,
    message: "Deletes/moves the homepage route (`/`).",
  }));
}

/** Post-execution: removals whose route no longer exists and has no redirect. */
export function unredirectedRemovals(cwd: string, removals: PendingRouteRemoval[], cfg: SeoGuardConfig): Finding[] {
  const sev = severityOf(cfg, "route-removed");
  if (sev === "off" || !removals.length) return [];
  const files = walk(cwd, cfg.ignore);
  const live = new Set<string>();
  const sources: string[] = [];
  for (const f of files) {
    const info = fileToRoute(f);
    if (info) live.add(info.route);
    if (isRedirectConfig(f)) { const c = readText(resolve(cwd, f)); if (c) sources.push(...redirectSources(f, c)); }
  }
  const out: Finding[] = [];
  for (const r of removals) {
    if (live.has(r.route) || redirectCovers(sources, r.route)) continue;
    out.push({ rule: "route-removed", severity: sev, file: r.file, message: `Route \`${r.route}\` no longer exists and no redirect (vercel.json / netlify.toml / _redirects / next.config) covers it — old URL will 404. Add a redirect or restore the page.` });
  }
  return out;
}

export { isLayoutFile, extractFacts };
