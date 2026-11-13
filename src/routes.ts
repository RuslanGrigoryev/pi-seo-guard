import { basename } from "node:path";

/** Source extensions that count as route files for each framework. */
const PAGE_EXT = "(?:tsx|jsx|ts|js|mdx|md|astro|vue|svelte|html)";

export interface RouteInfo { route: string; framework: "next-app" | "next-pages" | "astro" | "sveltekit" | "nuxt"; }

function clean(parts: string[]): string {
  const segs = parts
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@")) // (groups), @parallel slots
    .map((s) => s.replace(/^\[\[\.\.\.(\w+)\]\]$/, "*").replace(/^\[\.\.\.(\w+)\]$/, "*").replace(/^\[(\w+)\]$/, ":$1").replace(/^_{1,2}(\w+)_{0,2}$/, ":$1"));
  return "/" + segs.join("/");
}

/**
 * Map a project-relative path (forward slashes) to a route, using the file-routing
 * conventions of Next (app + pages router), Astro, SvelteKit and Nuxt. Returns null for non-route files.
 */
export function fileToRoute(rel: string): RouteInfo | null {
  rel = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  // monorepo: apps/<name>/…, packages/<name>/…, or a top-level website|www|site|web|docs dir
  const ws = /^(?:(?:apps|packages|sites)\/[\w.-]+|website|www|site|web|docs)\/((?:src\/|app\/|pages\/|routes\/).*)$/.exec(rel);
  if (ws) rel = ws[1];
  let m: RegExpExecArray | null;
  // Next app router
  if ((m = new RegExp(`^(?:src/)?app/(?:(.*)/)?page\\.${PAGE_EXT}$`).exec(rel)) && !/\.html$/.test(rel)) {
    return { route: clean((m[1] ?? "").split("/")), framework: "next-app" };
  }
  // Astro
  if ((m = new RegExp(`^src/pages/(.*)\\.(?:astro|md|mdx|html)$`).exec(rel))) {
    const parts = m[1].split("/");
    if (parts.some((p) => p.startsWith("_"))) return null;
    if (parts[parts.length - 1] === "index") parts.pop();
    return { route: clean(parts), framework: "astro" };
  }
  // SvelteKit
  if ((m = /^src\/routes\/(?:(.*)\/)?\+page(?:@[\w-]*)?\.(?:svelte|md|svx)$/.exec(rel))) {
    return { route: clean((m[1] ?? "").split("/")), framework: "sveltekit" };
  }
  // Nuxt (pages/ or app/pages/)
  if ((m = /^(?:app\/)?pages\/(.*)\.vue$/.exec(rel)) && !/^src\//.test(rel)) {
    const parts = m[1].split("/");
    if (parts[parts.length - 1] === "index") parts.pop();
    return { route: clean(parts), framework: "nuxt" };
  }
  // Next pages router (pages/ or src/pages/ with js/ts/jsx/tsx/mdx)
  if ((m = /^(?:src\/)?pages\/(.*)\.(?:tsx|jsx|ts|js|mdx|md)$/.exec(rel))) {
    const parts = m[1].split("/");
    if (parts[0] === "api" || parts.some((p) => p.startsWith("_"))) return null;
    if (parts[parts.length - 1] === "index") parts.pop();
    return { route: clean(parts), framework: "next-pages" };
  }
  return null;
}

export const isHomepage = (route: string) => route === "/";
export const isDynamic = (route: string) => /[:*]/.test(route);

export function routeToRegExp(route: string): RegExp {
  try { return routeToRegExpUnsafe(route); } catch { return /(?!)/; }
}
function routeToRegExpUnsafe(route: string): RegExp {
  route = route.replace(/\*{2,}/g, "*");
  const optionalRoot = route.endsWith("/*") ? route.slice(0, -2) || "/" : null; // optional catch-all also matches its parent
  if (optionalRoot) return new RegExp(`^(?:${routeToRegExpUnsafe(optionalRoot).source.slice(1, -1)}|${routeToRegExpUnsafe(route.replace(/\/\*$/, "/\u0000")).source.slice(1, -1).replace("\u0000", ".+")})$`);
  const src = route.split("/").map((s) => (s === "*" ? ".*" : s.startsWith(":") ? "[^/]+" : s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("/");
  try { return new RegExp("^" + src + "$"); } catch { return /(?!)/; }
}

export function normalizePath(p: string): string {
  p = p.split(/[?#]/)[0];
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** Does `path` resolve to one of the route patterns? */
export function matchesRoute(routes: Iterable<string>, path: string): boolean {
  path = normalizePath(path);
  for (const r of routes) if (r === path || (isDynamic(r) && routeToRegExp(r).test(path))) return true;
  return false;
}

// ---- redirects ----

const REDIRECT_FILES = /^(?:vercel\.json|netlify\.toml|_redirects|firebase\.json|\.htaccess|nginx\.conf|[\w.-]*\.nginx(?:\.conf)?|(?:next|astro|nuxt|docusaurus)\.config\.(?:js|mjs|cjs|ts|mts)|hooks\.server\.(?:js|ts|mjs|mts))$/;
export const isRedirectConfig = (rel: string) =>
  REDIRECT_FILES.test(basename(rel)) || /(^|\/)public\/_redirects$/.test(rel) || /(^|\/)(?:nginx|conf\.d|sites-(?:available|enabled))\/[^/]+\.conf$/.test(rel);

/** Convert a (simple) regex path pattern to our route-pattern syntax, or null if too complex. */
export function regexToRoute(re: string): string | null {
  try {
    let s = re.trim().replace(/^\(\?i\)/, "").replace(/^\^/, "").replace(/\$$/, "");
    s = s.replace(/\/\?$/, "").replace(/\(\/\)\?$/, "");
    s = s.replace(/\((?:\?:)?\.[*+]\??\)/g, "*").replace(/\((?:\?:)?(?:\[\^\/\]|\[\\?[\w\-0-9a-zA-Z]+\]|\\[dw])[+*]\??\)/g, ":p");
    s = s.replace(/\.[*+]\??$/, "*").replace(/\\([.\-/_~])/g, "$1");
    if (/[()|\\?+{}[\]^$]/.test(s.replace(/\*/g, ""))) return null;
    if (!s.startsWith("/")) s = "/" + s;
    return s.replace(/\*{2,}/g, "*").replace(/\/+$/, "") || "/";
  } catch { return null; }
}

function expandBraces(g: string): string[] {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return m[1].split(",").flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
}

/** Path of a redirect source: strips scheme+host and query string. */
function srcPath(t: string): string {
  t = t.replace(/^https?:\/\/[^/\s]+/i, "");
  return t.split(/[?#]/)[0];
}

/** Extract redirect *source* paths from a redirect config file. Best-effort; never throws. */
export function redirectSources(file: string, content: string): string[] {
  const out = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s !== "string" || !s.startsWith("/")) return;
    out.add(s.replace(/:(\w+)\*/g, "*").replace(/\/:path\*/g, "/*").replace(/\*{2,}/g, "*"));
  };
  try { collect(basename(file), content, add); } catch { /* best-effort */ }
  return [...out];
}

function collect(name: string, content: string, add: (s: unknown) => void): void {
  if (name === "_redirects") {
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      add(srcPath(t.split(/\s+/)[0])); // `/a /b 301!`, `/blog/* /news/:splat`, `/p/:id /q/:id`, `https://host/a /b`
    }
  } else if (name === "netlify.toml") {
    for (const m of content.matchAll(/^\s*from\s*=\s*["']([^"']+)["']/gm)) add(srcPath(m[1]));
  } else if (name === "vercel.json") {
    try {
      const j = JSON.parse(content);
      for (const r of [...(j.redirects ?? []), ...(j.rewrites ?? [])]) if (typeof r?.source === "string") add(r.source);
    } catch { for (const m of content.matchAll(/"source"\s*:\s*"([^"]+)"/g)) add(m[1]); }
  } else if (name === "firebase.json") {
    let list: unknown[] = [];
    try {
      const j = JSON.parse(content);
      const hosts = Array.isArray(j?.hosting) ? j.hosting : j?.hosting ? [j.hosting] : [];
      list = hosts.flatMap((h: { redirects?: unknown[] }) => (Array.isArray(h?.redirects) ? h.redirects : []));
    } catch { /* malformed JSON */ }
    for (const r of list as { source?: string; regex?: string }[]) {
      if (typeof r?.source === "string") for (const g of expandBraces(r.source)) add(g);
      else if (typeof r?.regex === "string") add(regexToRoute(r.regex));
    }
  } else if (name === ".htaccess") {
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      let m: RegExpExecArray | null;
      if ((m = /^Redirect(?:Permanent|Temp)?\s+(?:(?:30[1278]|permanent|temp|seeother|gone)\s+)?(\/\S*)/i.exec(line))) {
        add(m[1].replace(/\/+$/, "") + "/*"); // Redirect is a prefix match; /* also covers the bare path
      } else if ((m = /^RedirectMatch\s+(?:(?:30[1278]|permanent|temp|seeother|gone)\s+)?(\S+)/i.exec(line))) {
        add(regexToRoute(m[1].replace(/^"|"$/g, "")));
      } else if ((m = /^RewriteRule\s+(\S+)\s+\S+\s+\[([^\]]*)\]/i.exec(line)) && /\bR(?:=\d+)?\b/i.test(m[2])) {
        add(regexToRoute(m[1].replace(/^"|"$/g, "")));
      }
    }
  } else if (/\.nginx(?:\.conf)?$|\.conf$/.test(name)) {
    const nc = content.replace(/^\s*#.*$/gm, "");
    for (const m of nc.matchAll(/\brewrite\s+(\S+)\s+\S+\s+(?:permanent|redirect)\s*;/g)) add(regexToRoute(m[1].replace(/^["']|["']$/g, "")));
    for (const m of nc.matchAll(/\blocation\s+(=\s+|~\*?\s+|\^~\s+)?(\S+)\s*\{[^{}]*?\breturn\s+30[12378]\b/g)) {
      const mod = (m[1] ?? "").trim(), p = m[2].replace(/^["']|["']$/g, "");
      if (mod.startsWith("~")) add(regexToRoute(p));
      else if (mod === "=") add(p);
      else if (p !== "/") add(p.replace(/\/+$/, "") + "/*"); // prefix location
    }
  } else if (name.startsWith("docusaurus.config")) {
    if (!/client-redirects/.test(content)) return;
    for (const m of content.matchAll(/\bfrom\s*:\s*(\[[^\]]*\]|(['"`])[^'"`]*\2)/g)) for (const s of m[1].matchAll(/(['"`])([^'"`]*)\1/g)) add(s[2]);
  } else if (/^hooks\.server\./.test(name)) {
    // simple forms only: `pathname === '/old'` followed by redirect(…), or an object/Map literal of '/old': '/new'
    for (const m of content.matchAll(/pathname\s*===?\s*(['"`])(\/[^'"`]*)\1[^;{}]{0,80}?(?:\)\s*(?:\{|=>)?\s*)?[\s\S]{0,120}?\bredirect\s*\(/g)) add(m[2]);
    for (const m of content.matchAll(/\b(?:redirects?|redirectMap|redirectsMap|REDIRECTS)\b[^=]*=\s*(?:new Map\(\s*)?(\[|\{)([\s\S]*?)(?:\]\s*\)|\]|\})\s*;/g)) {
      for (const e of m[2].matchAll(/(['"`])(\/[^'"`]*)\1\s*[:,]\s*(['"`])\/?[^'"`]*\3/g)) add(e[2]);
    }
  } else {
    // next.config: only `{ source, destination }` pairs (not `headers()` entries)
    for (const m of content.matchAll(/\bsource\s*:\s*(['"`])([^'"`]+)\1[^{}]{0,200}?\bdestination\s*:/g)) add(m[2]);
    const r = /\bredirects\s*:\s*\{([\s\S]*?)\n?\s*\}\s*[,}]/.exec(content); // astro.config
    if (r) for (const m of r[1].matchAll(/(['"`])(\/[^'"`]*)\1\s*:/g)) add(m[2]);
    for (const m of content.matchAll(/(['"`])(\/[^'"`]*)\1\s*:\s*\{\s*redirect\b/g)) add(m[2]); // nuxt routeRules
  }
}

export function redirectCovers(sources: Iterable<string>, route: string): boolean {
  for (const s of sources) {
    if (s === route) return true;
    try {
      if (/[:*]/.test(s) && routeToRegExp(s).test(route)) return true;
      // route "/blog/:slug" is covered by "/blog/*" or "/blog/:slug"
      if (isDynamic(route) && s.replace(/\*$/, "") !== "" && route.startsWith(s.replace(/\/?\*$/, "") + "/") && s.endsWith("*")) return true;
    } catch { /* bad pattern: ignore */ }
  }
  return false;
}
