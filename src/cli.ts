#!/usr/bin/env node
/**
 * pi-seo-guard CLI — runs the same rules as the Pi extension, without Pi.
 *   pi-seo-guard check [--base <ref>] [--format text|json|github] [--fail-on critical|warn|none]
 *   pi-seo-guard scan  [--format …] [--fail-on …]
 * Deliberately imports nothing from `index.ts` / `@earendil-works/pi-coding-agent`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type SeoGuardConfig } from "./config.ts";
import { criticalRemovalFindings, isWatched, unredirectedRemovals, type PendingRouteRemoval } from "./guard.ts";
import { SeoLedger } from "./ledger.ts";
import { gitReader, diskReader } from "./resolve.ts";
import { type Finding, diffFile, formatFindings } from "./rules.ts";
import { fileToRoute } from "./routes.ts";
import { formatScan, scanProject } from "./scan.ts";
import { matchesAny } from "./glob.ts";
import { NOISE_PATH, SKIP_DIRS } from "./fs.ts";

export type Format = "text" | "json" | "github";
export type FailOn = "critical" | "warn" | "none";
export interface LocatedFinding extends Finding { line: number }

const USAGE = `Usage:
  pi-seo-guard check [--base <ref>] [--format text|json|github] [--fail-on critical|warn|none]
  pi-seo-guard scan  [--format text|json|github] [--fail-on critical|warn|none]

check  diffs the working tree against <ref> (default: origin/$GITHUB_BASE_REF in PR runs, else HEAD) and reports SEO regressions
scan   full-project scan (same as /seo-guard in Pi)
--fail-on: exit 1 on findings at or above this level (default: critical)`;

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
}

export interface Change { status: "A" | "M" | "D" | "R"; path: string; oldPath?: string }

/** Changed files between `base` and the working tree (tracked changes + untracked files). */
export function changedFiles(cwd: string, base: string): Change[] | null {
  const out = git(cwd, ["diff", "--name-status", "-M", "-z", "--no-renames-limit", base, "--"]) ?? git(cwd, ["diff", "--name-status", "-M", "-z", base, "--"]);
  if (out === null) return null;
  const parts = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const st = parts[i++];
    if (st[0] === "R" || st[0] === "C") { const o = parts[i++], n = parts[i++]; changes.push(st[0] === "R" ? { status: "R", path: n, oldPath: o } : { status: "A", path: n }); }
    else changes.push({ status: (st[0] === "D" ? "D" : st[0] === "A" ? "A" : "M"), path: parts[i++] });
  }
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const p of (untracked ?? "").split("\0").filter(Boolean)) if (!changes.some((c) => c.path === p)) changes.push({ status: "A", path: p });
  return changes;
}

const relevant = (p: string, cfg: SeoGuardConfig) =>
  !matchesAny(cfg.ignore, p) && !p.split("/").some((s) => SKIP_DIRS.has(s)) && !NOISE_PATH.test(p) && isWatched(p);

/** Best-effort 1-based line of the construct a finding is about (for annotations). */
function locate(f: Finding, content: string | null): number {
  if (!content) return 1;
  const pat: Partial<Record<string, RegExp>> = {
    "title-removed": /<title|\btitle\b/i, "description-removed": /description/i, "canonical-removed": /canonical/i,
    "noindex-added": /noindex|robots/i, "sitewide-noindex": /noindex|robots/i, "component-noindex": /noindex/i, "nofollow-added": /nofollow/,
    "robots-disallow-all": /^\s*disallow\s*:\s*\/\s*$/im, "h1-removed": /<h1|^#\s/i, "jsonld-removed": /ld\+json/i, "jsonld-invalid": /ld\+json/i,
    "hreflang-changed": /hreflang|languages/i, "img-alt-removed": /<img|<Image/i, "img-dimensions-removed": /<img|<Image/i,
  };
  const re = pat[f.rule];
  if (!re) return 1;
  const lines = content.split("\n");
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? 1 : i + 1;
}

export interface CheckResult { findings: LocatedFinding[]; base: string; filesChanged: number; notes: string[] }

export function runCheck(cwd: string, baseArg: string | undefined, cfg: SeoGuardConfig): CheckResult {
  const notes: string[] = [];
  const label = baseArg ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "HEAD");
  let base = label;
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) === null) throw new Error("not a git repository");
  if (git(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
    throw new Error(`cannot resolve base ref "${base}" (in CI use actions/checkout with fetch-depth: 0, or pass --base)`);
  }
  // PR semantics: compare against the merge-base so changes that landed on the base branch afterwards aren't reported as removals
  const mb = git(cwd, ["merge-base", base, "HEAD"])?.trim();
  if (mb) base = mb;
  const changes = changedFiles(cwd, base);
  if (changes === null) throw new Error(`git diff against ${base} failed`);

  const before = gitReader(cwd, base), after = diskReader(cwd);
  const ledger = new SeoLedger();
  const found: LocatedFinding[] = [];
  const removals: PendingRouteRemoval[] = [];
  const push = (fs: Finding[], content: string | null) => { for (const f of fs) found.push({ ...f, line: locate(f, content) }); };
  const read = (p: string) => after.read(p);

  for (const c of changes) {
    const p = c.path;
    if (c.status === "D" || (c.status === "R" && c.oldPath)) {
      const gone = c.status === "D" ? p : c.oldPath!;
      if (!matchesAny(cfg.ignore, gone)) { const info = fileToRoute(gone); if (info) removals.push({ file: gone, route: info.route }); }
      if (c.status === "D") continue;
    }
    if (!relevant(p, cfg)) continue;
    const src = read(p);
    if (src === null) continue;
    const oldPath = c.status === "R" ? c.oldPath! : p;
    const old = c.status === "A" ? null : before.read(oldPath);
    const fs = diffFile(p, old, src, cfg, { before, after });
    push(ledger.observe(cwd, p, src, fs), src);
  }

  push(criticalRemovalFindings(removals, cfg), null);
  const rest = removals.filter((r) => r.route !== "/");
  // a route "removed" by a rename is fine when the same route lives on (unredirectedRemovals checks the working tree)
  push(unredirectedRemovals(cwd, rest, cfg), null);

  if (!changes.length) notes.push(`No changes against ${label}.`);
  return { findings: found, base: label, filesChanged: changes.length, notes };
}

// ---- output ----

const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function formatGithub(fs: LocatedFinding[]): string {
  return fs.map((f) => `::${f.severity === "critical" ? "error" : "warning"} file=${escProp(f.file)},line=${f.line},title=${escProp(`seo-guard: ${f.rule}`)}::${esc(f.message)}`).join("\n");
}

export function shouldFail(fs: Finding[], failOn: FailOn): boolean {
  if (failOn === "none") return false;
  return failOn === "warn" ? fs.length > 0 : fs.some((f) => f.severity === "critical");
}

function parseArgs(argv: string[]): { cmd?: string; base?: string; format: Format; failOn: FailOn; cwd?: string; error?: string; help?: boolean } {
  const o: ReturnType<typeof parseArgs> = { format: "text", failOn: "critical" };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift()!;
    const val = (name: string) => { const eq = a.indexOf("="); return eq > 0 ? a.slice(eq + 1) : rest.shift(); void name; };
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--base" || a.startsWith("--base=")) o.base = val("base");
    else if (a === "--format" || a.startsWith("--format=")) { const v = val("format"); if (v === "text" || v === "json" || v === "github") o.format = v; else o.error = `invalid --format "${v}"`; }
    else if (a === "--fail-on" || a.startsWith("--fail-on=")) { const v = val("fail-on"); if (v === "critical" || v === "warn" || v === "none") o.failOn = v; else o.error = `invalid --fail-on "${v}"`; }
    else if (a === "--cwd" || a.startsWith("--cwd=")) o.cwd = val("cwd");
    else if (a.startsWith("-")) o.error = `unknown option ${a}`;
    else if (!o.cmd) o.cmd = a;
    else o.error = `unexpected argument ${a}`;
  }
  return o;
}

export interface CliIO { out: (s: string) => void; err: (s: string) => void }

/** Returns the process exit code. */
export function main(argv: string[], io: CliIO = { out: (s) => console.log(s), err: (s) => console.error(s) }, cwd0 = process.cwd()): number {
  const o = parseArgs(argv);
  if (o.help || !o.cmd) { io.out(USAGE); return o.help ? 0 : 2; }
  if (o.error || (o.cmd !== "check" && o.cmd !== "scan")) { io.err(`pi-seo-guard: ${o.error ?? `unknown command "${o.cmd}"`}\n${USAGE}`); return 2; }
  const cwd = resolve(cwd0, o.cwd ?? ".");
  const { config, error } = loadConfig(cwd);
  if (error) io.err(`pi-seo-guard: ${error}`);
  let findings: LocatedFinding[];
  let text: string;
  const extra: Record<string, unknown> = {};
  try {
    if (o.cmd === "check") {
      const r = runCheck(cwd, o.base, config);
      findings = r.findings;
      extra.base = r.base; extra.filesChanged = r.filesChanged;
      text = findings.length
        ? `pi-seo-guard: ${findings.length} SEO finding(s) vs ${r.base}\n${formatFindings(findings)}`
        : `pi-seo-guard: no SEO regressions vs ${r.base} (${r.filesChanged} file(s) changed)`;
      for (const n of r.notes) text += `\nnote: ${n}`;
    } else {
      const r = scanProject(cwd, config);
      findings = r.findings.map((f) => ({ ...f, line: locate(f, existsSync(resolve(cwd, f.file)) ? readFileSync(resolve(cwd, f.file), "utf8") : null) }));
      extra.routes = r.routes; extra.filesScanned = r.filesScanned; extra.notes = r.notes;
      text = formatScan(r);
    }
  } catch (e) { io.err(`pi-seo-guard: ${(e as Error).message}`); return 2; }

  if (o.format === "json") io.out(JSON.stringify({ command: o.cmd, ...extra, failOn: o.failOn, findings }, null, 2));
  else if (o.format === "github") { if (findings.length) io.out(formatGithub(findings)); io.out(text); }
  else io.out(text);
  return shouldFail(findings, o.failOn) ? 1 : 0;
}

// run only when executed directly (also through the npm .bin symlink)
const self = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })() : "";
if (self && self === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
