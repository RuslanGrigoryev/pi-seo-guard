import { DEFAULT_SEVERITIES, type RuleId, type SeoGuardConfig } from "./config.ts";
import { globToRegExp, matchesAny } from "./glob.ts";
import { fileToRoute } from "./routes.ts";
import type { Finding } from "./rules.ts";

/**
 * Inline suppression comments, anywhere in a file:
 *   `// seo-guard-ignore noindex-added`   `<!-- seo-guard-ignore title-removed, h1-removed -->`
 *   `{/* seo-guard-ignore *​/}`            `# seo-guard-ignore …`
 * No rule names = every NON-critical rule. Critical rules (site-wide noindex, robots.txt Disallow:/, homepage removal…)
 * can only be suppressed by naming them: a bare/wildcard ignore is too easy to paste by accident or to let an agent add
 * blindly, and these rules guard against whole-site de-indexing.
 */
export function inlineIgnores(content: string | null | undefined): { all: boolean; rules: Set<string> } {
  const out = { all: false, rules: new Set<string>() };
  if (!content || !content.includes("seo-guard-ignore")) return out;
  for (const m of content.matchAll(/(?:\/\/|\/\*|<!--|\{\/\*|#|--)\s*seo-guard-ignore\b([^\n]*)/g)) {
    const list = m[1].replace(/\*\/\s*\}?.*$|-->.*$|\*\/.*$/, "").split(/[\s,]+/).filter((t) => /^[a-z][a-z0-9-]*$/.test(t));
    const named = list.filter((t) => t in DEFAULT_SEVERITIES);
    if (named.length) named.forEach((t) => out.rules.add(t));
    else out.all = true;
  }
  return out;
}

/** Route globs: `/staging/*` covers the whole subtree (and `/staging` itself); `[id]`-style dynamic routes are matched as written. */
function routeMatches(globs: string[], route: string): boolean {
  return globs.some((g) => {
    if (globToRegExp(g).test(route)) return true;
    const m = /^(.*?)\/\*{1,2}$/.exec(g);
    return !!m && (route === (m[1] || "/") || route.startsWith(m[1] + "/"));
  });
}

const isCritical = (f: Finding, rule: RuleId) => f.severity === "critical" || DEFAULT_SEVERITIES[rule] === "critical";

/** Is this finding suppressed by `.seo-guard.json` ignore entries or an inline comment in `content`? */
export function isIgnored(f: Finding, cfg: SeoGuardConfig, content?: string | null): boolean {
  const critical = isCritical(f, f.rule);
  const inline = inlineIgnores(content);
  if (inline.rules.has(f.rule) || (inline.all && !critical)) return true;
  const route = fileToRoute(f.file)?.route;
  for (const e of cfg.ignoreRules ?? []) {
    if (e.rule ? e.rule !== f.rule : critical) continue;
    if (!e.routes && !e.paths) { if (e.rule) return true; continue; } // `{rule}` alone: ignore that rule everywhere
    if (e.paths && matchesAny(e.paths, f.file)) return true;
    if (e.routes && route && routeMatches(e.routes, route)) return true;
  }
  return false;
}

export function filterIgnored(findings: Finding[], cfg: SeoGuardConfig, content?: string | null): Finding[] {
  return findings.filter((f) => !isIgnored(f, cfg, content));
}
