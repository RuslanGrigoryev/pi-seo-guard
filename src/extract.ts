import { Parser } from "htmlparser2";

export type Presence = "present" | "empty" | "absent";

export interface Facts {
  title: Presence;
  description: Presence;
  canonical: Presence;
  noindex: boolean;
  nofollow: boolean;
  h1: number;
  imgTotal: number;
  imgNoAlt: number;
  /** `<img>`/`next/image` without width+height (CLS risk). */
  imgNoDim: number;
  /** noindex came from a component prop (`<NextSeo noindex>`, `<SEO noindex>`). */
  noindexProp: boolean;
  /** `lang|href` of hreflang alternates. */
  hreflang: string[];
  jsonLd: number;
  /** JSON-LD blocks that are provably not valid JSON. */
  jsonLdInvalid: number;
}

export const emptyFacts = (): Facts => ({
  title: "absent", description: "absent", canonical: "absent",
  noindex: false, nofollow: false, h1: 0, imgTotal: 0, imgNoAlt: 0,
  imgNoDim: 0, noindexProp: false, hreflang: [], jsonLd: 0, jsonLdInvalid: 0,
});

const rank: Record<Presence, number> = { absent: 0, empty: 1, present: 2 };
const best = (a: Presence, b: Presence): Presence => (rank[a] >= rank[b] ? a : b);

export function mergeFacts(a: Facts, b: Facts): Facts {
  return {
    title: best(a.title, b.title), description: best(a.description, b.description),
    canonical: best(a.canonical, b.canonical),
    noindex: a.noindex || b.noindex, nofollow: a.nofollow || b.nofollow,
    h1: a.h1 + b.h1, imgTotal: a.imgTotal + b.imgTotal, imgNoAlt: a.imgNoAlt + b.imgNoAlt,
    imgNoDim: a.imgNoDim + b.imgNoDim, noindexProp: a.noindexProp || b.noindexProp,
    hreflang: [...a.hreflang, ...b.hreflang], jsonLd: a.jsonLd + b.jsonLd, jsonLdInvalid: a.jsonLdInvalid + b.jsonLdInvalid,
  };
}

export type FileKind = "html" | "jsx" | "astro" | "vue" | "svelte" | "md" | "script";

export function kindOf(path: string): FileKind | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  switch (m?.[1].toLowerCase()) {
    case "html": case "htm": return "html";
    case "jsx": case "tsx": return "jsx";
    case "astro": return "astro";
    case "vue": return "vue";
    case "svelte": return "svelte";
    case "md": case "mdx": return "md";
    case "ts": case "js": case "mjs": case "mts": return "script";
    default: return null;
  }
}

function robotsDirectives(content: string, f: Facts) {
  const c = content.toLowerCase();
  if (/\bnoindex\b|\bnone\b/.test(c)) f.noindex = true;
  if (/\bnofollow\b|\bnone\b/.test(c)) f.nofollow = true;
}

const SEO_COMPONENT = /^(?:NextSeo|SEO|Seo|SeoHead|SeoMeta|Head|Meta|MetaTags|[A-Z]\w*(?:Head|Seo|SEO))$/;
const LAYOUT_COMPONENT = /^(?:[A-Z]\w*)?Layout$/;
const JSONLD_COMPONENT = /^(?:\w*JsonLd|\w*JSONLD|\w*JsonLD)$/;
/** `{ ...template }` / `${}` markers: the text is templated, so its JSON validity can't be judged. */
const TEMPLATED = /\{\{|\$\{|\{[#@:/]?\s*[A-Za-z_$(.\[`]|\{`/;

function propPresence(v: string | undefined): Presence {
  if (v === undefined) return "absent";
  const t = v.trim();
  if (!t || /^\{\s*(["'`])\1\s*\}$/.test(t)) return "empty";
  return "present";
}
const propTrue = (attrs: Record<string, string>, k: string) =>
  k in attrs && !/^\{?\s*["']?false["']?\s*\}?$/i.test(attrs[k].trim());

/** Parse markup (html/jsx/astro/vue/svelte) with htmlparser2. Lenient: never throws. */
export function extractMarkup(src: string, kind: FileKind): Facts {
  const f = emptyFacts();
  if (kind === "astro") src = src.replace(/^\s*---[\s\S]*?\n---/, "");
  if (kind === "jsx" || kind === "astro") src = src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
  const staticImages = new Set<string>();
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+['"][^'"]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^'"]*)?['"]/gi)) staticImages.add(m[1]);
  let inTitle = false;
  let titleText = "";
  let titleSeen = false;
  let inLd = false;
  let ldText = "";
  let ldAttrsTemplated = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const lc = name === "title" || name === "TITLE" ? "title" : name;
        const spread = Object.keys(attrs).some((k) => k.startsWith("{") || k.startsWith("..."));
        if (lc === "title") { inTitle = true; titleText = ""; titleSeen = true; }
        else if (name === "h1" || name === "H1") f.h1++;
        else if (name === "img" || name === "IMG" || name === "Image") {
          f.imgTotal++;
          if (!("alt" in attrs) && !spread) f.imgNoAlt++;
          const isNextImage = name === "Image" && kind === "jsx";
          if ((name !== "Image" || isNextImage) && !spread) {
            const cls = attrs.class ?? attrs.classname ?? "";
            const style = attrs.style ?? "";
            const sized = ("width" in attrs && "height" in attrs)
              || (isNextImage && ("fill" in attrs || staticImages.has(/^\{\s*(\w+)\s*\}$/.exec(attrs.src ?? "")?.[1] ?? "")))
              || /\baspect-/.test(cls) || /\bsize-\S+/.test(cls) || (/(?:^|[\s"'`:])w-\S+/.test(cls) && /(?:^|[\s"'`:])h-\S+/.test(cls))
              || /aspect-ratio|\bheight\s*:/.test(style);
            if (!sized) f.imgNoDim++;
          }
        } else if (name === "meta") {
          const n = (attrs.name ?? "").toLowerCase();
          const content = attrs.content ?? "";
          if (n === "description") f.description = best(f.description, content.trim() ? "present" : "empty");
          if (n === "robots" || n === "googlebot") robotsDirectives(content, f);
        } else if (name === "link" && (attrs.rel ?? "").toLowerCase() === "canonical") {
          f.canonical = best(f.canonical, (attrs.href ?? "").trim() ? "present" : "empty");
        } else if (name === "link" && /\balternate\b/i.test(attrs.rel ?? "") && attrs.hreflang) {
          f.hreflang.push(`${attrs.hreflang.toLowerCase()}|${(attrs.href ?? "").trim()}`);
        } else if ((name === "script" || name === "Script") && /ld\+json/i.test(attrs.type ?? "")) {
          f.jsonLd++; inLd = true; ldText = "";
          ldAttrsTemplated = spread || Object.keys(attrs).some((k) => /^(?:set:html|dangerouslysetinnerhtml|src|v-html|:inner-?html|innerhtml)$/.test(k) || k.startsWith("{@html"));
        } else if (JSONLD_COMPONENT.test(name)) {
          f.jsonLd++;
        } else if (SEO_COMPONENT.test(name) || (kind === "astro" && LAYOUT_COMPONENT.test(name))) {
          // SEO component props: <NextSeo title description canonical noindex>, <SEO title=…>, <Layout title=…> (astro)
          // custom wrapper (`<MdxHead params={…}/>`) that takes no title prop delegates to another module: assume it supplies them
          const delegating = !LAYOUT_COMPONENT.test(name) && !/^(?:NextSeo|SEO|Seo|Head|Meta|MetaTags|SeoHead|SeoMeta)$/.test(name) && !("title" in attrs) && Object.keys(attrs).length > 0;
          f.title = best(f.title, delegating ? "present" : propPresence(attrs.title));
          f.description = best(f.description, delegating ? "present" : propPresence(attrs.description));
          const canon = attrs.canonical ?? attrs.canonicalurl ?? attrs.canonical_url;
          f.canonical = best(f.canonical, propPresence(canon));
          if (propTrue(attrs, "noindex")) { f.noindex = true; f.noindexProp = true; }
          if (propTrue(attrs, "nofollow")) f.nofollow = true;
          if (typeof attrs.robots === "string") robotsDirectives(attrs.robots, f);
        }
      },
      ontext(t) { if (inTitle) titleText += t; if (inLd) ldText += t; },
      onclosetag(name, isImplied) {
        if ((name === "title" || name === "TITLE") && inTitle) {
          inTitle = false;
          f.title = best(f.title, titleText.trim() ? "present" : "empty");
        }
        if (inLd && (name === "script" || name === "Script")) {
          inLd = false;
          const t = ldText.trim();
          if (t && !TEMPLATED.test(t)) { try { JSON.parse(t); } catch { f.jsonLdInvalid++; } }
          else if (!t && !ldAttrsTemplated && kind === "html") f.jsonLdInvalid++;
        }
        void isImplied;
      },
    },
    { lowerCaseTags: false, lowerCaseAttributeNames: true, recognizeSelfClosing: true, decodeEntities: false },
  );
  try { parser.write(src); parser.end(); } catch { /* lenient */ }
  if (titleSeen && f.title === "absent") f.title = "empty";
  return f;
}

function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Regex-based extraction of Next.js `metadata` / `generateMetadata` (and Nuxt useHead/useSeoMeta). */
export function extractMetadata(src: string): Facts {
  const f = emptyFacts();
  const regions: string[] = [];
  const re = /export\s+(?:const|let)\s+metadata\b[^=]*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const i = m.index + m[0].length;
    if (src[i] === "{") regions.push(balanced(src, i));
  }
  const g = /generateMetadata\b/.exec(src);
  if (g) regions.push(src.slice(g.index, g.index + 3000));
  const h = /\b(?:useHead|useSeoMeta|definePageMeta)\s*\(/g;
  while ((m = h.exec(src))) regions.push(src.slice(m.index, m.index + 1500));
  // Remix `meta` / `links` exports
  const rx = /export\s+(?:async\s+)?(?:const|function)\s+(?:meta|links)\b/g;
  while ((m = rx.exec(src))) regions.push(src.slice(m.index, m.index + 2500));
  const region = regions.join("\n");
  if (!region) return f;
  const hasMetaExport = /export\s+(?:async\s+)?(?:const|function)\s+meta\b/.test(src);

  const val = (key: string): Presence => {
    const r = new RegExp(`\\b${key}\\s*:\\s*`, "g");
    let best_: Presence = "absent";
    let mm: RegExpExecArray | null;
    while ((mm = r.exec(region))) {
      const rest = region.slice(mm.index + mm[0].length);
      const q = /^(['"`])(.*?)\1/s.exec(rest);
      if (q) best_ = best(best_, q[2].trim() ? "present" : "empty");
      else if (/^[{\w(\[]/.test(rest)) best_ = best(best_, "present");
    }
    // shorthand property: `{ title, description }`
    if (best_ === "absent" && new RegExp(`[{,]\\s*${key}\\s*(?:,|\\}|$)`, "m").test(region)) best_ = "present";
    return best_;
  };
  f.title = val("title");
  f.description = val("description");
  const canon = /\bcanonical\s*:\s*(['"`])(.*?)\1|\bcanonical\s*:\s*[\w{(]/s.exec(region);
  if (canon) f.canonical = canon[2] === "" ? "empty" : "present";
  const relCanon = /\brel\s*:\s*['"]canonical['"][^}]*?\bhref\s*:\s*(['"`])(.*?)\1|\bhref\s*:\s*(['"`])(.*?)\3[^}]*?\brel\s*:\s*['"]canonical['"]/s.exec(region);
  if (relCanon) f.canonical = best(f.canonical, (relCanon[2] ?? relCanon[4] ?? "").trim() ? "present" : "empty");
  // meta-array objects: { name: "description", content: "…" } / { name: "robots", content: "noindex" } (Nuxt useHead, Remix meta)
  for (const o of region.matchAll(/\{[^{}]*\}/g)) {
    const nm = /\bname\s*:\s*(['"])([^'"]+)\1/.exec(o[0])?.[2]?.toLowerCase();
    if (!nm) continue;
    const c = /\bcontent\s*:\s*(?:(['"`])(.*?)\1|([^,}\s][^,}]*))/s.exec(o[0]);
    if (!c) continue;
    if (nm === "description") f.description = best(f.description, c[1] ? (c[2].trim() ? "present" : "empty") : "present");
    else if ((nm === "robots" || nm === "googlebot") && c[1]) robotsDirectives(c[2], f);
  }
  // hreflang: Next `alternates.languages`, link objects `{ rel: 'alternate', hreflang, href }`
  const lg = /\blanguages\s*:\s*\{/.exec(region);
  if (lg) {
    const block = balanced(region, lg.index + lg[0].length - 1);
    for (const e of block.matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"`])(.*?)\2/g)) f.hreflang.push(`${e[1].toLowerCase()}|${e[3]}`);
  }
  for (const o of region.matchAll(/\{[^{}]*\}/g)) {
    const hl = /\bhreflang\s*:\s*(['"])([\w-]+)\1/i.exec(o[0]);
    const hr = /\bhref\s*:\s*(['"`])(.*?)\1/.exec(o[0]);
    if (hl) f.hreflang.push(`${hl[2].toLowerCase()}|${hr ? hr[2] : ""}`);
  }
  f.jsonLd += (region.match(/application\/ld\+json/g) ?? []).length;
  void hasMetaExport;
  if (/\brobots\s*:\s*(['"`])[^'"`]*noindex/i.test(region) || /\brobots\s*:\s*\{[^}]*\bindex\s*:\s*false/s.test(region)) f.noindex = true;
  if (/\brobots\s*:\s*(['"`])[^'"`]*nofollow/i.test(region) || /\brobots\s*:\s*\{[^}]*\bfollow\s*:\s*false/s.test(region)) f.nofollow = true;
  return f;
}

/** Markdown/MDX: YAML-ish frontmatter (simple `key: value` only) + `# H1` + inline HTML. */
export function extractMarkdown(src: string): Facts {
  const f = emptyFacts();
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  let body = src;
  if (fm) {
    body = src.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const v = kv[2].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
      const p: Presence = v ? "present" : "empty";
      if (key === "title") f.title = p;
      else if (key === "description" || key === "summary") f.description = best(f.description, p);
      else if (key === "canonical" || key === "canonicalurl" || key === "canonical_url") f.canonical = p;
      else if (key === "noindex" && /^(true|yes|1)$/i.test(v)) f.noindex = true;
      else if (key === "nofollow" && /^(true|yes|1)$/i.test(v)) f.nofollow = true;
      else if (key === "robots") robotsDirectives(v, f);
    }
  }
  const noFences = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  f.h1 += (noFences.match(/^#\s+\S/gm) ?? []).length;
  const imgs = noFences.match(/!\[[^\]]*\]\([^)]*\)/g) ?? [];
  f.imgTotal += imgs.length;
  f.imgNoAlt += imgs.filter((s) => /^!\[\s*\]/.test(s)).length;
  const html = extractMarkup(noFences, "html");
  return mergeFacts(f, { ...html, title: "absent" });
}

export function extractFacts(path: string, src: string): Facts | null {
  const kind = kindOf(path);
  if (!kind) return null;
  if (kind === "md") return extractMarkdown(src);
  if (kind === "script") return /\bmetadata\b|generateMetadata|useHead|useSeoMeta|export\s+(?:async\s+)?(?:const|function)\s+(?:meta|links)\b|ld\+json/.test(src) ? extractMetadata(src) : null;
  return mergeFacts(extractMarkup(src, kind), extractMetadata(src));
}
