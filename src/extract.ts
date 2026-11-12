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
}

export const emptyFacts = (): Facts => ({
  title: "absent", description: "absent", canonical: "absent",
  noindex: false, nofollow: false, h1: 0, imgTotal: 0, imgNoAlt: 0,
});

const rank: Record<Presence, number> = { absent: 0, empty: 1, present: 2 };
const best = (a: Presence, b: Presence): Presence => (rank[a] >= rank[b] ? a : b);

export function mergeFacts(a: Facts, b: Facts): Facts {
  return {
    title: best(a.title, b.title), description: best(a.description, b.description),
    canonical: best(a.canonical, b.canonical),
    noindex: a.noindex || b.noindex, nofollow: a.nofollow || b.nofollow,
    h1: a.h1 + b.h1, imgTotal: a.imgTotal + b.imgTotal, imgNoAlt: a.imgNoAlt + b.imgNoAlt,
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

/** Parse markup (html/jsx/astro/vue/svelte) with htmlparser2. Lenient: never throws. */
export function extractMarkup(src: string, kind: FileKind): Facts {
  const f = emptyFacts();
  if (kind === "astro") src = src.replace(/^\s*---[\s\S]*?\n---/, "");
  let inTitle = false;
  let titleText = "";
  let titleSeen = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const lc = name === "title" || name === "TITLE" ? "title" : name;
        if (lc === "title") { inTitle = true; titleText = ""; titleSeen = true; }
        else if (name === "h1" || name === "H1") f.h1++;
        else if (name === "img" || name === "IMG" || name === "Image") {
          f.imgTotal++;
          const hasSpread = Object.keys(attrs).some((k) => k.startsWith("{") || k.startsWith("..."));
          if (!("alt" in attrs) && !hasSpread) f.imgNoAlt++;
        } else if (name === "meta") {
          const n = (attrs.name ?? "").toLowerCase();
          const content = attrs.content ?? "";
          if (n === "description") f.description = best(f.description, content.trim() ? "present" : "empty");
          if (n === "robots" || n === "googlebot") robotsDirectives(content, f);
        } else if (name === "link" && (attrs.rel ?? "").toLowerCase() === "canonical") {
          f.canonical = best(f.canonical, (attrs.href ?? "").trim() ? "present" : "empty");
        }
      },
      ontext(t) { if (inTitle) titleText += t; },
      onclosetag(name, isImplied) {
        if ((name === "title" || name === "TITLE") && inTitle) {
          inTitle = false;
          f.title = best(f.title, titleText.trim() ? "present" : "empty");
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
  const region = regions.join("\n");
  if (!region) return f;

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
    return best_;
  };
  f.title = val("title");
  f.description = val("description");
  const canon = /\bcanonical\s*:\s*(['"`])(.*?)\1|\bcanonical\s*:\s*[\w{(]/s.exec(region);
  if (canon) f.canonical = canon[2] === "" ? "empty" : "present";
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
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
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
  if (kind === "script") return /\bmetadata\b|generateMetadata|useHead|useSeoMeta/.test(src) ? extractMetadata(src) : null;
  return mergeFacts(extractMarkup(src, kind), extractMetadata(src));
}
