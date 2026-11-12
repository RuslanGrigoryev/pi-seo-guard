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
  const src = route.split("/").map((s) => (s === "*" ? ".*" : s.startsWith(":") ? "[^/]+" : s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp("^" + src + "$");
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

const REDIRECT_FILES = /^(?:vercel\.json|netlify\.toml|_redirects|(?:next|astro|nuxt)\.config\.(?:js|mjs|cjs|ts|mts))$/;
export const isRedirectConfig = (rel: string) => REDIRECT_FILES.test(basename(rel)) || /(^|\/)public\/_redirects$/.test(rel);

/** Extract redirect *source* paths from a redirect config file. Best-effort. */
export function redirectSources(file: string, content: string): string[] {
  const name = basename(file);
  const out = new Set<string>();
  const add = (s: string) => { if (s.startsWith("/")) out.add(s.replace(/:(\w+)\*/g, "*").replace(/\/:path\*/g, "/*")); };
  if (name === "_redirects") {
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) add(t.split(/\s+/)[0]);
    }
  } else if (name === "netlify.toml") {
    for (const m of content.matchAll(/^\s*from\s*=\s*["']([^"']+)["']/gm)) add(m[1]);
  } else if (name === "vercel.json") {
    try {
      const j = JSON.parse(content);
      for (const r of [...(j.redirects ?? []), ...(j.rewrites ?? [])]) if (typeof r?.source === "string") add(r.source);
    } catch { for (const m of content.matchAll(/"source"\s*:\s*"([^"]+)"/g)) add(m[1]); }
  } else {
    for (const m of content.matchAll(/\bsource\s*:\s*(['"`])([^'"`]+)\1/g)) add(m[2]); // next.config
    const r = /\bredirects\s*:\s*\{([\s\S]*?)\n?\s*\}\s*[,}]/.exec(content); // astro.config
    if (r) for (const m of r[1].matchAll(/(['"`])(\/[^'"`]*)\1\s*:/g)) add(m[2]);
    for (const m of content.matchAll(/(['"`])(\/[^'"`]*)\1\s*:\s*\{\s*redirect\b/g)) add(m[2]); // nuxt routeRules
  }
  return [...out];
}

export function redirectCovers(sources: Iterable<string>, route: string): boolean {
  for (const s of sources) {
    if (s === route) return true;
    if (/[:*]/.test(s) && routeToRegExp(s).test(route)) return true;
    // route "/blog/:slug" is covered by "/blog/*" or "/blog/:slug"
    if (isDynamic(route) && s.replace(/\*$/, "") !== "" && route.startsWith(s.replace(/\/?\*$/, "") + "/") && s.endsWith("*")) return true;
  }
  return false;
}
