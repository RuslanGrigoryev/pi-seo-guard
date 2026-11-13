import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Severity = "critical" | "warn" | "off";

export const DEFAULT_SEVERITIES = {
  "sitewide-noindex": "critical",
  "robots-disallow-all": "critical",
  "homepage-removed": "critical",
  "unverifiable-critical-write": "critical",
  "component-noindex": "critical",
  "title-removed": "warn",
  "description-removed": "warn",
  "canonical-removed": "warn",
  "noindex-added": "warn",
  "nofollow-added": "warn",
  "h1-removed": "warn",
  "img-alt-removed": "warn",
  "route-removed": "warn",
  "hreflang-changed": "warn",
  "jsonld-removed": "warn",
  "jsonld-invalid": "warn",
  "img-dimensions-removed": "warn",
  "redirect-removed": "warn",
  "sitemap-urls-removed": "warn",
  "unverifiable-write": "warn",
  // /seo-guard only
  "broken-link": "warn",
  "sitemap-missing-route": "warn",
  "missing-title": "warn",
  "missing-description": "warn",
  "missing-canonical": "warn",
} as const satisfies Record<string, Severity>;

export type RuleId = keyof typeof DEFAULT_SEVERITIES;

export interface IgnoreEntry {
  /** Rule to suppress; omitted = all non-critical rules. Critical rules are only suppressed when named explicitly. */
  rule?: RuleId;
  /** Globs matched against the route of the finding's file (`/staging/*`). */
  routes?: string[];
  /** Globs matched against the project-relative file path (`app/(internal)/**`). */
  paths?: string[];
}

export interface SeoGuardConfig {
  /** Globs (relative to project root) the guard never looks at. */
  ignore: string[];
  /** Per-rule allow-list: findings matching an entry are dropped. */
  ignoreRules?: IgnoreEntry[];
  /** Per-rule override: "critical" | "warn" | "off". */
  rules: Partial<Record<RuleId, Severity>>;
  /** Site base URL, used to treat absolute links / sitemap <loc> as internal. */
  baseUrl?: string;
  /** Snapshot the route list around every bash call to catch globs/find/rimraf/scripts (default true). */
  snapshotRoutes?: boolean;
}

export const CONFIG_PATH = ".pi/seo-guard.json";
/** Preferred, tool-agnostic config location (also read by the CLI / GitHub Action). Merged over `.pi/seo-guard.json`. */
export const ROOT_CONFIG_PATH = ".seo-guard.json";

const strArr = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : undefined);

function applyRaw(config: SeoGuardConfig, raw: any) {
  if (Array.isArray(raw.ignore)) {
    for (const x of raw.ignore) {
      if (typeof x === "string") config.ignore.push(x); // legacy: path glob the guard never looks at
      else if (x && typeof x === "object") {
        const rule = typeof x.rule === "string" && x.rule in DEFAULT_SEVERITIES ? (x.rule as RuleId) : undefined;
        if (typeof x.rule === "string" && !rule) continue; // unknown rule name: ignore the entry rather than widen it to "all rules"
        (config.ignoreRules ??= []).push({ rule, routes: strArr(x.routes), paths: strArr(x.paths) });
      }
    }
  }
  if (raw.rules && typeof raw.rules === "object") {
    for (const [k, v] of Object.entries(raw.rules)) {
      if (k in DEFAULT_SEVERITIES && (v === "critical" || v === "warn" || v === "off")) config.rules[k as RuleId] = v;
    }
  }
  if (typeof raw.baseUrl === "string") config.baseUrl = raw.baseUrl;
  if (typeof raw.snapshotRoutes === "boolean") config.snapshotRoutes = raw.snapshotRoutes;
}

export function loadConfig(cwd: string): { config: SeoGuardConfig; error?: string } {
  const config: SeoGuardConfig = { ignore: [], rules: {} };
  const errors: string[] = [];
  for (const path of [CONFIG_PATH, ROOT_CONFIG_PATH]) { // later file wins on scalar/rule conflicts; ignore lists concatenate
    const p = join(cwd, path);
    if (!existsSync(p)) continue;
    try { applyRaw(config, JSON.parse(readFileSync(p, "utf8"))); }
    catch (e) { errors.push(`Invalid ${path}: ${(e as Error).message} (skipped)`); }
  }
  return errors.length ? { config, error: errors.join("; ") } : { config };
}

export function severityOf(cfg: SeoGuardConfig, rule: RuleId): Severity {
  return cfg.rules[rule] ?? DEFAULT_SEVERITIES[rule];
}
