import { resolve } from "node:path";
import { type SeoGuardConfig, severityOf } from "./config.ts";
import { matchesAny } from "./glob.ts";
import { type Finding, isLayoutFile, sitemapLocs } from "./rules.ts";
import { extractFacts, kindOf } from "./extract.ts";
import { fileToRoute, isDynamic, isRedirectConfig, matchesRoute, normalizePath, redirectCovers, redirectSources } from "./routes.ts";
import { isIgnored } from "./ignore.ts";
import { diskReader } from "./resolve.ts";
import { ancestorsOf } from "./inherit.ts";
import { gitHeadFiles, readText, walk } from "./fs.ts";

export interface ScanResult { findings: Finding[]; routes: number; filesScanned: number; notes: string[] }

const PUBLIC_DIRS = /^(?:public|static)\//;
const SITEMAP_GENERATORS = /(^|\/)(sitemap\.(?:ts|js|mjs)|next-sitemap\.config\.[cm]?js)$/;

function internalPath(href: string, baseUrl?: string): string | null {
  href = href.trim();
  if (baseUrl && href.startsWith(baseUrl.replace(/\/$/, ""))) href = href.slice(baseUrl.replace(/\/$/, "").length) || "/";
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (/[{}$<>]|\s/.test(href)) return null; // templated
  return normalizePath(href);
}

export function extractLinks(src: string, kind: string): string[] {
  const out: string[] = [];
  if (kind === "md") for (const m of src.matchAll(/(?<!!)\[[^\]]*\]\(\s*(\/[^)\s]*)/g)) out.push(m[1]);
  for (const m of src.matchAll(/<a\b[^>]*?\b(?:href|to)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out.push(m[1] ?? m[2]);
  for (const m of src.matchAll(/<(?:Link|NuxtLink|RouterLink)\b[^>]*?\b(?:href|to)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.push(m[1] ?? m[2]);
  return out;
}

export function scanProject(cwd: string, cfg: SeoGuardConfig): ScanResult {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const add = (rule: Finding["rule"], file: string, message: string) => {
    const severity = severityOf(cfg, rule);
    if (severity === "off") return;
    const f: Finding = { rule, severity, file, message };
    if (!isIgnored(f, cfg, read(file))) findings.push(f);
  };

  const files = walk(cwd, cfg.ignore);
  const reader = diskReader(cwd);
  const xf = (f: string, src: string) => extractFacts(f, src, reader);
  const text = new Map<string, string>();
  const read = (f: string) => { if (!text.has(f)) text.set(f, readText(resolve(cwd, f)) ?? ""); return text.get(f)!; };

  const routes = new Map<string, string>(); // route -> file
  const staticFiles = new Set<string>();
  const redirectSrc: string[] = [];
  for (const f of files) {
    const info = fileToRoute(f);
    if (info) routes.set(info.route, f);
    if (PUBLIC_DIRS.test(f)) {
      const p = "/" + f.replace(PUBLIC_DIRS, "");
      staticFiles.add(p);
      if (p.endsWith(".html")) routes.set(p.replace(/\/index\.html$/, "") || "/", f);
    }
    if (isRedirectConfig(f)) redirectSrc.push(...redirectSources(f, read(f)));
  }
  const routeSet = routes.keys();
  void routeSet;

  // 1. metadata per page
  const layoutFacts = files.filter((f) => /layout|BaseHead|Head|Seo/i.test(f) && kindOf(f)).map((f) => xf(f, read(f))).filter(Boolean);
  // canonical is optional: only expect it per page when the project uses it somewhere
  const canonicalConvention = (() => {
    // canonical is optional: expect it per page only when most pages (or a layout) declare it
    const pages = [...routes.values()].filter((f) => { const k = kindOf(f); return k && k !== "script"; });
    const withCanon = pages.filter((f) => xf(f, read(f))?.canonical === "present").length;
    const inLayout = files.some((f) => isLayoutFile(f) && xf(f, read(f))?.canonical === "present");
    return inLayout || (pages.length > 0 && withCanon / pages.length >= 0.5);
  })();
  const layoutHas = (k: "title" | "description" | "canonical") => layoutFacts.some((x) => x![k] === "present");
  for (const [route, f] of routes) {
    if (isDynamic(route) && /\.(?:[jt]sx?)$/.test(f) && !/generateMetadata|metadata/.test(read(f))) { /* still check below */ }
    const k = kindOf(f);
    if (!k || k === "script") continue;
    const facts = xf(f, read(f));
    if (!facts) continue;
    const frontLayout = k === "md" && /^---[\s\S]*?\blayout\s*:/m.test(read(f));
    const next = /^(?:src\/)?(?:app|pages)\//.test(f);
    const fileSet = new Set(files);
    const anc = ancestorsOf(f, read(f), (r) => fileSet.has(r), (r) => (fileSet.has(r) ? read(r) : null))
      .map((a) => xf(a, read(a))).filter(Boolean) as NonNullable<ReturnType<typeof extractFacts>>[];
    // ancestors found (Next nesting, Astro/Vue/Svelte imports) → trust them; none resolvable → fall back to any layout-like file
    const inherit = (key: "title" | "description" | "canonical") => frontLayout || (anc.length ? anc.some((x) => x[key] === "present") : layoutHas(key && key) && !next);
    if (k === "vue" && /<template>\s*<(?:NuxtPage|RouterView|router-view)\b[^>]*\/?>(?:\s*<\/(?:NuxtPage|RouterView|router-view)>)?\s*<\/template>/.test(read(f))) continue; // pure parent-route wrapper
    if (/http-equiv\s*=\s*["']refresh|\bnavigateTo\(|\bredirect\(|Astro\.redirect\(|\bpermanentRedirect\(/.test(read(f))) continue; // redirect-only page
    if (facts.noindex || anc.some((x) => x.noindex)) continue; // not meant for search: no title/description expectations
    if (facts.title !== "present" && !inherit("title")) add("missing-title", f, `Route \`${route}\` has no title.`);
    if (facts.description !== "present" && !inherit("description")) add("missing-description", f, `Route \`${route}\` has no meta description.`);
    if (canonicalConvention && facts.canonical !== "present" && !inherit("canonical")) add("missing-canonical", f, `Route \`${route}\` has no canonical link.`);
  }

  // 2. broken internal links (needs a route table: without one — e.g. a docs-only repo — every link would be "broken")
  if (routes.size === 0) notes.push("No file-based routes found; broken-link check skipped.");
  const seenBroken = new Set<string>();
  for (const f of routes.size === 0 ? [] : files) {
    const k = kindOf(f);
    if (!k || k === "script") continue;
    // markdown that isn't itself a page is a content-collection entry: its routes come from a catch-all/CMS we can't enumerate
    if (k === "md" && !fileToRoute(f)) continue;
    for (const href of extractLinks(read(f), k)) {
      const p = internalPath(href, cfg.baseUrl);
      if (!p || p.startsWith("/api/")) continue;
      if (matchesRoute(routes.keys(), p) || staticFiles.has(p) || redirectCovers(redirectSrc, p)) continue;
      if (/\.[a-z0-9]{2,5}$/i.test(p) && !p.endsWith(".html")) continue; // asset we can't verify
      const key = `${f}|${p}`;
      if (seenBroken.has(key)) continue;
      seenBroken.add(key);
      add("broken-link", f, `Link to \`${p}\` matches no route, static file or redirect.`);
    }
  }

  // 3. sitemap coverage
  const sitemaps = files.filter((f) => /(^|\/)sitemap\.xml$/.test(f));
  if (sitemaps.length) {
    const inMap = new Set<string>();
    for (const s of sitemaps) for (const loc of sitemapLocs(read(s))) {
      try { inMap.add(normalizePath(new URL(loc).pathname)); } catch { const p = internalPath(loc, cfg.baseUrl); if (p) inMap.add(p); }
    }
    for (const [route, f] of routes) {
      if (isDynamic(route) || inMap.has(route)) continue;
      add("sitemap-missing-route", f, `Route \`${route}\` is not listed in ${sitemaps[0]}.`);
    }
  } else if (files.some((f) => SITEMAP_GENERATORS.test(f)) || files.some((f) => /^(?:astro|nuxt)\.config\./.test(f) && /sitemap/i.test(read(f))) || files.some((f) => /^package\.json$/.test(f) && /sitemap/i.test(read(f)))) {
    notes.push("Sitemap is generated at build time; static sitemap check skipped.");
  } else if (routes.size) notes.push("No sitemap.xml found; sitemap check skipped.");

  // 4. removed routes vs git HEAD
  const head = gitHeadFiles(cwd);
  if (head === null) notes.push("Not a git repository (or no commits); removed-route check skipped.");
  else {
    const headRoutes = new Map<string, string>();
    for (const f of head) if (!matchesAny(cfg.ignore, f)) { const i = fileToRoute(f); if (i) headRoutes.set(i.route, f); }
    for (const [route, f] of headRoutes) {
      if (routes.has(route) || redirectCovers(redirectSrc, route)) continue;
      add("route-removed", f, `Route \`${route}\` existed in git HEAD but is gone and has no redirect.`);
    }
  }
  return { findings, routes: routes.size, filesScanned: files.length, notes };
}

export function formatScan(r: ScanResult): string {
  const lines = [`SEO check: ${r.routes} route(s), ${r.filesScanned} file(s) scanned — ${r.findings.length} finding(s)`];
  const groups = new Map<string, Finding[]>();
  for (const f of r.findings) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
  for (const [rule, fs] of groups) {
    lines.push("", `${rule} (${fs.length})`);
    for (const f of fs.slice(0, 25)) lines.push(`  [${f.severity.toUpperCase()}] ${f.file}: ${f.message}`);
    if (fs.length > 25) lines.push(`  … and ${fs.length - 25} more`);
  }
  for (const n of r.notes) lines.push("", `note: ${n}`);
  return lines.join("\n");
}
