import { existsSync } from "node:fs";
import { dirname, posix } from "node:path";
import { kindOf } from "./extract.ts";
import { readText } from "./fs.ts";
import { resolve } from "node:path";

const EXTS = ["", ".tsx", ".jsx", ".ts", ".js", ".mjs", ".astro", ".vue", ".svelte", ".mdx", "/index.tsx", "/index.jsx", "/index.ts", "/index.js", "/index.astro", "/index.vue", "/index.svelte"];
/** Imported modules whose name suggests they provide <head> / page chrome. */
const LAYOUTISH = /(?:layout|head|seo|meta|base|shell|template|document|wrapper|page)[^/]*$/i;

export type Exists = (rel: string) => boolean;
export const diskExists = (cwd: string): Exists => (r) => existsSync(resolve(cwd, r));

function firstExisting(cands: string[], exists: Exists): string | null {
  for (const c of cands) if (exists(c) && kindOf(c)) return c;
  return null;
}

function importSpecs(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Resolve an import specifier from `file` to a project file (relative paths + common aliases `@/ ~/ $lib/ @scope/`). */
export function resolveImport(file: string, spec: string, exists: Exists): string | null {
  const bases: string[] = [];
  if (spec.startsWith(".")) bases.push(posix.normalize(posix.join(posix.dirname(file), spec)));
  else {
    const m = /^(?:@|~|\$|#)[\w-]*\/(.*)$/.exec(spec) ?? /^~~?\/(.*)$/.exec(spec);
    if (!m) return null;
    const rest = m[1];
    bases.push(`src/${rest}`, rest, `src/lib/${rest}`, `app/${rest}`);
    if (spec.startsWith("$lib/")) bases.unshift(`src/lib/${rest}`);
  }
  for (const b of bases) { const r = firstExisting(EXTS.map((e) => b + e), exists); if (r) return r; }
  return null;
}

/** Structural (file-system) layout ancestors by framework convention. */
export function structuralAncestors(file: string, content: string, exists: Exists): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (p !== file && exists(p) && !out.includes(p)) out.push(p); };
  const exts = ["tsx", "jsx", "ts", "js"];
  let m: RegExpExecArray | null;
  if ((m = /^((?:src\/)?app)\/(.*)$/.exec(file))) {
    const parts = m[2].split("/"); parts.pop();
    let d = m[1];
    for (const e of exts) add(`${d}/layout.${e}`);
    for (const p of parts) { d += "/" + p; for (const e of exts) add(`${d}/layout.${e}`); }
  }
  if (/^(?:src\/)?pages\//.test(file) && !/\.(?:astro|vue)$/.test(file) && !/^src\/pages\/.*\.(?:md|mdx|html)$/.test(file) || /^(?:src\/)?pages\/.*\.(?:tsx|jsx)$/.test(file)) {
    const base = file.startsWith("src/") ? "src/pages" : "pages";
    for (const n of ["_app", "_document"]) for (const e of exts) add(`${base}/${n}.${e}`);
  }
  if ((m = /^src\/routes\/(.*)$/.exec(file))) {
    const parts = m[1].split("/"); parts.pop();
    let d = "src/routes";
    add(`${d}/+layout.svelte`);
    for (const p of parts) { d += "/" + p; add(`${d}/+layout.svelte`); }
    add("src/app.html");
  }
  if (/^(?:app\/)?pages\/.*\.vue$/.test(file) || /^(?:app\/)?layouts\/.*\.vue$/.test(file)) {
    const pre = file.startsWith("app/") ? "app/" : "";
    add(`${pre}app.vue`); add("app.vue"); add(`${pre}layouts/default.vue`); add("layouts/default.vue");
    const l = /definePageMeta\s*\(\s*\{[^}]*\blayout\s*:\s*['"]([\w-]+)['"]/s.exec(content)?.[1];
    if (l) { add(`${pre}layouts/${l}.vue`); add(`layouts/${l}.vue`); }
    for (const e of ["ts", "js", "mjs"]) add(`nuxt.config.${e}`);
  }
  if (/^src\/pages\//.test(file)) { /* astro: layouts come via imports */ }
  return out;
}

/** All layout/parent files whose SEO facts `file` can inherit: structural ancestors + imported layout-ish components (transitive). */
export function ancestorsOf(file: string, content: string, exists: Exists, read: (rel: string) => string | null, depth = 3): string[] {
  const out = new Set<string>(structuralAncestors(file, content, exists));
  const seen = new Set<string>([file]);
  const rec = (f: string, src: string, d: number, top: boolean) => {
    for (const spec of importSpecs(src)) {
      const r = resolveImport(f, spec, exists);
      if (!r || seen.has(r)) continue;
      if (!LAYOUTISH.test(r) && !(top && /(?:layout|head|seo|meta|base)/i.test(spec))) continue;
      seen.add(r); out.add(r);
      if (d > 1) { const c = read(r); if (c) rec(r, c, d - 1, false); }
    }
  };
  rec(file, content, depth, true);
  for (const a of [...out]) { // layouts also inherit from their structural ancestors
    const c = read(a);
    if (c !== null) for (const s of structuralAncestors(a, c, exists)) out.add(s);
  }
  out.delete(file);
  return [...out];
}

export const makeReader = (cwd: string) => (r: string) => readText(resolve(cwd, r));
void dirname;
