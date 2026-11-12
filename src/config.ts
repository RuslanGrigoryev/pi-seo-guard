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

export interface SeoGuardConfig {
  /** Globs (relative to project root) the guard never looks at. */
  ignore: string[];
  /** Per-rule override: "critical" | "warn" | "off". */
  rules: Partial<Record<RuleId, Severity>>;
  /** Site base URL, used to treat absolute links / sitemap <loc> as internal. */
  baseUrl?: string;
  /** Snapshot the route list around every bash call to catch globs/find/rimraf/scripts (default true). */
  snapshotRoutes?: boolean;
}

export const CONFIG_PATH = ".pi/seo-guard.json";

export function loadConfig(cwd: string): { config: SeoGuardConfig; error?: string } {
  const config: SeoGuardConfig = { ignore: [], rules: {} };
  const p = join(cwd, CONFIG_PATH);
  if (!existsSync(p)) return { config };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(raw.ignore)) config.ignore = raw.ignore.filter((x: unknown) => typeof x === "string");
    if (raw.rules && typeof raw.rules === "object") {
      for (const [k, v] of Object.entries(raw.rules)) {
        if (k in DEFAULT_SEVERITIES && (v === "critical" || v === "warn" || v === "off")) {
          config.rules[k as RuleId] = v;
        }
      }
    }
    if (typeof raw.baseUrl === "string") config.baseUrl = raw.baseUrl;
    if (typeof raw.snapshotRoutes === "boolean") config.snapshotRoutes = raw.snapshotRoutes;
    return { config };
  } catch (e) {
    return { config, error: `Invalid ${CONFIG_PATH}: ${(e as Error).message} (using defaults)` };
  }
}

export function severityOf(cfg: SeoGuardConfig, rule: RuleId): Severity {
  return cfg.rules[rule] ?? DEFAULT_SEVERITIES[rule];
}
