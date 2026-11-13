import { basename } from "node:path";
import { type Facts, extractFacts } from "./extract.ts";
import { type RuleId, type Severity, type SeoGuardConfig, severityOf } from "./config.ts";
import type { Reader } from "./resolve.ts";
import { isRedirectConfig, redirectSources } from "./routes.ts";

export interface Finding {
  rule: RuleId;
  severity: Exclude<Severity, "off">;
  file: string;
  message: string;
}

const LAYOUT_RE = /(^|\/)(layout\.[jt]sx?|_document\.[jt]sx?|_app\.[jt]sx?|\+layout\.svelte|app\.html|default\.vue|app\.vue|[\w-]*(?:Layout|BaseHead|Head|Seo|Base)\.(?:astro|vue|svelte|[jt]sx))$/;
export const isLayoutFile = (rel: string) => LAYOUT_RE.test(rel);
const ROOT_LAYOUT = /^(?:src\/)?app\/layout\.[jt]sx?$|^(?:src\/)?pages\/_(?:document|app)\.[jt]sx?$|^src\/routes\/\+layout\.svelte$|^src\/app\.html$/;

export const isRootLayout = (rel: string) => ROOT_LAYOUT.test(rel);

function mk(cfg: SeoGuardConfig, rule: RuleId, file: string, message: string): Finding | null {
  const severity = severityOf(cfg, rule);
  return severity === "off" ? null : { rule, severity, file, message };
}

/** Parse robots.txt: true if the `*` group contains `Disallow: /` with no `Allow: /` override. */
export function robotsBlocksAll(txt: string): boolean {
  let inStar = false, prevWasUA = false, blocks = false, allowAll = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      inStar = prevWasUA ? inStar || v === "*" : v === "*";
      prevWasUA = true;
      continue;
    }
    prevWasUA = false;
    if (!inStar) continue;
    if (k === "disallow" && /^\/(\*|\$)?$/.test(v)) blocks = true;
    if (k === "allow" && /^\/(\*)?$/.test(v)) allowAll = true;
  }
  return blocks && !allowAll;
}

export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map((m) => m[1]);
}

/** Compare before/after content of one file and return findings. `before` null = new file. */
export function diffFile(rel: string, before: string | null, after: string, cfg: SeoGuardConfig, readers?: { before?: Reader; after?: Reader }): Finding[] {
  const out: (Finding | null)[] = [];
  const name = basename(rel);

  if (name === "robots.txt") {
    if (robotsBlocksAll(after) && !(before && robotsBlocksAll(before)))
      out.push(mk(cfg, "robots-disallow-all", rel, "robots.txt now has `User-agent: *` + `Disallow: /` — this blocks crawling of the entire site."));
    return out.filter(Boolean) as Finding[];
  }

  if (name === "sitemap.xml") {
    if (before) {
      const was = new Set(sitemapLocs(before)), now = new Set(sitemapLocs(after));
      const gone = [...was].filter((u) => !now.has(u));
      if (gone.length) out.push(mk(cfg, "sitemap-urls-removed", rel, `sitemap.xml lost ${gone.length} URL(s): ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", …" : ""}`));
    }
    return out.filter(Boolean) as Finding[];
  }

  if (isRedirectConfig(rel)) {
    if (before) {
      const now = new Set(redirectSources(rel, after));
      const gone = redirectSources(rel, before).filter((s) => !now.has(s) && !/\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|map|woff2?|pdf)$/i.test(s)); // static-asset redirects are noise
      if (gone.length) out.push(mk(cfg, "redirect-removed", rel, `Redirect rule(s) removed for: ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", …" : ""} — old URLs will 404.`));
    }
    const xr = (s: string) => /x-robots-tag[^\n]{0,80}noindex/i.test(s);
    if (xr(after) && !(before && xr(before)))
      out.push(mk(cfg, "sitewide-noindex", rel, "Adds an `X-Robots-Tag: noindex` header — if it applies to all paths the whole site drops out of search."));
    return out.filter(Boolean) as Finding[];
  }

  const a = extractFacts(rel, after, readers?.after);
  if (!a) return [];
  const b: Facts | null = before === null ? null : extractFacts(rel, before, readers?.before ?? readers?.after);
  if (!b) {
    // brand-new file: only flag directives that are harmful regardless of history
    if (a.noindex && isLayoutFile(rel)) out.push(mk(cfg, "sitewide-noindex", rel, "Layout sets noindex — applies to every page that uses it."));
    return out.filter(Boolean) as Finding[];
  }

  const lost = (k: "title" | "description" | "canonical") => b[k] === "present" && a[k] !== "present";
  const how = (k: "title" | "description" | "canonical") => (a[k] === "empty" ? "emptied" : "removed");
  if (lost("title")) out.push(mk(cfg, "title-removed", rel, `Title ${how("title")} (<title> / metadata.title / frontmatter title).`));
  if (lost("description")) out.push(mk(cfg, "description-removed", rel, `Meta description ${how("description")}.`));
  if (lost("canonical")) out.push(mk(cfg, "canonical-removed", rel, `Canonical link ${how("canonical")}.`));
  if (a.noindexProp && !b.noindexProp && !b.noindex && !ROOT_LAYOUT.test(rel) && !(isLayoutFile(rel) && /layout/i.test(basename(rel))))
    out.push(mk(cfg, "component-noindex", rel, "`noindex` prop added to an SEO/layout component (<NextSeo noindex>, <SEO noindex>, <Layout noindex>) — this page will be dropped from search results."));
  else if (a.noindex && !b.noindex) {
    const sitewide = ROOT_LAYOUT.test(rel) || (isLayoutFile(rel) && /layout/i.test(basename(rel)));
    out.push(sitewide
      ? mk(cfg, "sitewide-noindex", rel, "noindex added to a layout — applies to every page under it (site-wide de-indexing).")
      : mk(cfg, "noindex-added", rel, "noindex added — this page will be dropped from search results."));
  }
  if (a.nofollow && !b.nofollow) out.push(mk(cfg, "nofollow-added", rel, "nofollow added to robots meta — links on this page won't pass signals."));
  if (b.h1 > 0 && a.h1 === 0) out.push(mk(cfg, "h1-removed", rel, "No <h1> left in this file (it had one before)."));
  if (a.imgNoAlt > b.imgNoAlt) out.push(mk(cfg, "img-alt-removed", rel, `${a.imgNoAlt - b.imgNoAlt} more <img> without alt text than before.`));
  if (b.hreflang.length) {
    const now = new Set(a.hreflang);
    const gone = b.hreflang.filter((x) => !now.has(x));
    if (gone.length) {
      const langs = [...new Set(gone.map((x) => x.split("|")[0]))];
      const kept = new Set(a.hreflang.map((x) => x.split("|")[0]));
      const removedLangs = langs.filter((l) => !kept.has(l));
      out.push(mk(cfg, "hreflang-changed", rel, removedLangs.length
        ? `hreflang alternate(s) removed: ${removedLangs.slice(0, 6).join(", ")}${removedLangs.length > 6 ? ", …" : ""}.`
        : `hreflang alternate URL(s) changed for: ${langs.slice(0, 6).join(", ")}.`));
    }
  }
  if (a.jsonLd < b.jsonLd) out.push(mk(cfg, "jsonld-removed", rel, `${b.jsonLd - a.jsonLd} JSON-LD structured-data block(s) removed.`));
  if (a.jsonLdInvalid > b.jsonLdInvalid) out.push(mk(cfg, "jsonld-invalid", rel, "A JSON-LD block is no longer valid JSON — search engines will ignore it."));
  if (a.imgNoDim > b.imgNoDim) out.push(mk(cfg, "img-dimensions-removed", rel, `${a.imgNoDim - b.imgNoDim} more <img>/<Image> without width+height than before (layout shift / CLS).`));
  return out.filter(Boolean) as Finding[];
}

export function formatFindings(fs: Finding[]): string {
  return fs.map((f) => `- [${f.severity.toUpperCase()}] ${f.rule} (${f.file}): ${f.message}`).join("\n");
}
