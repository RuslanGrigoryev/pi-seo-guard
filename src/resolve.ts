/**
 * Best-effort value resolution for SEO props set through indirection:
 * same-file consts / object properties, one hop through relative or tsconfig-`paths` imports,
 * and (via `props`) wrapper components. Anything it cannot follow is "unknown" — callers treat that as
 * "present" so unresolvable code never produces a finding.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { posix, resolve as pathResolve } from "node:path";

export type Presence = "present" | "empty" | "absent";

export interface Reader { read(rel: string): string | null; exists(rel: string): boolean; /** underlying reader (cache key for tsconfig lookups) */ root?: Reader }

export const emptyReader: Reader = { read: () => null, exists: () => false };

/** Resolution context for one file. */
export interface Rc {
  reader: Reader;
  /** Project-relative path of the file being analysed. */
  file: string;
  /** Wrapper-component analysis: presence of the props the caller passed (keys lower-cased). */
  props?: Record<string, Presence>;
  /** True while analysing a wrapper (no further wrapper hops). */
  wrap?: boolean;
}

export function diskReader(cwd: string): Reader {
  const cache = new Map<string, string | null>();
  return {
    read(rel) {
      if (cache.has(rel)) return cache.get(rel)!;
      let v: string | null = null;
      try { const abs = pathResolve(cwd, rel); if (statSync(abs).size <= 2_000_000) v = readFileSync(abs, "utf8"); } catch { /* missing */ }
      cache.set(rel, v);
      return v;
    },
    exists: (rel) => existsSync(pathResolve(cwd, rel)),
  };
}

/** Reader over a git ref (`git show ref:path`); `ref` may be "" for the working tree. */
export function gitReader(cwd: string, ref: string): Reader {
  if (!ref) return diskReader(cwd);
  const cache = new Map<string, string | null>();
  const read = (rel: string) => {
    if (cache.has(rel)) return cache.get(rel)!;
    let v: string | null = null;
    try { v = execFileSync("git", ["show", `${ref}:${rel}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 << 20 }); } catch { /* missing */ }
    cache.set(rel, v);
    return v;
  };
  return { read, exists: (rel) => read(rel) !== null };
}

/** Reader that serves `override` for one path and defers to `base` otherwise. */
export function overlayReader(base: Reader, file: string, content: string | null): Reader {
  return {
    read: (r) => (r === file ? content : base.read(r)),
    exists: (r) => (r === file ? content !== null : base.exists(r)),
    root: base.root ?? base,
  };
}

// ---------- JS text scanning ----------

function skipString(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (q === "`" && c === "$" && s[j + 1] === "{") { j = skipBalanced(s, j + 1); continue; }
    if (c === q) return j + 1;
    if (q !== "`" && c === "\n") return j;
    j++;
  }
  return j;
}

/** s[i] is an opening bracket; returns the index just after its matching close. */
function skipBalanced(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") { j = skipString(s, j) - 1; continue; }
    if (c === "/" && s[j + 1] === "/") { const n = s.indexOf("\n", j); if (n < 0) return s.length; j = n; continue; }
    if (c === "/" && s[j + 1] === "*") { const n = s.indexOf("*/", j + 2); if (n < 0) return s.length; j = n + 1; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") { if (--depth === 0) return j + 1; }
  }
  return s.length;
}

const CONT_END = /[+\-*/|&?:=,(<>.]$/;
const CONT_START = /^(?:\|\||\?\?|&&|\+|\?|:|\.|\bas\b|\bsatisfies\b)/;

/** Read one JS expression starting at `i` (stops at `;` `,` or an unbalanced closer / ASI newline at depth 0). */
export function readExpr(s: string, i: number): string {
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") { j = skipString(s, j); continue; }
    if (c === "{" || c === "(" || c === "[") { j = skipBalanced(s, j); continue; }
    if (c === "/" && s[j + 1] === "/") { const n = s.indexOf("\n", j); j = n < 0 ? s.length : n; continue; }
    if (c === "/" && s[j + 1] === "*") { const n = s.indexOf("*/", j + 2); j = n < 0 ? s.length : n + 2; continue; }
    if (c === ";" || c === "," || c === "}" || c === ")" || c === "]") break;
    if (c === "\n") {
      const soFar = s.slice(i, j).trimEnd();
      const next = s.slice(j).trimStart();
      if (!soFar || CONT_END.test(soFar) || CONT_START.test(next)) { j++; continue; }
      break;
    }
    j++;
  }
  return s.slice(i, j).trim();
}

/** Split on a top-level binary operator (`||`, `??`). */
function splitTop(e: string, ops: string[]): string[] | null {
  const parts: string[] = [];
  let last = 0, found = false;
  for (let j = 0; j < e.length; j++) {
    const c = e[j];
    if (c === '"' || c === "'" || c === "`") { j = skipString(e, j) - 1; continue; }
    if (c === "{" || c === "(" || c === "[") { j = skipBalanced(e, j) - 1; continue; }
    for (const op of ops) if (e.startsWith(op, j)) { parts.push(e.slice(last, j)); last = j + op.length; j = last - 1; found = true; break; }
  }
  if (!found) return null;
  parts.push(e.slice(last));
  return parts;
}

interface ObjEntry { key: string; value: string | null; spread: boolean }

function parseObject(text: string): ObjEntry[] {
  const out: ObjEntry[] = [];
  let i = text.indexOf("{") + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text.startsWith("//", i)) { const n = text.indexOf("\n", i); i = n < 0 ? text.length : n; continue; }
    if (text.startsWith("/*", i)) { const n = text.indexOf("*/", i); i = n < 0 ? text.length : n + 2; continue; }
    if (i >= text.length || text[i] === "}") break;
    if (text.startsWith("...", i)) { const e = readExpr(text, i + 3); out.push({ key: "", value: e, spread: true }); i += 3 + e.length; continue; }
    let key: string;
    const q = text[i];
    if (q === '"' || q === "'" || q === "`") { const end = skipString(text, i); key = text.slice(i + 1, end - 1); i = end; }
    else { const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i)); if (!m) { i++; continue; } key = m[0]; i += key.length; }
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === ":") {
      const e = readExpr(text, i + 1);
      out.push({ key, value: e, spread: false });
      i += 1 + (text.slice(i + 1).indexOf(e) + e.length);
    } else if (text[i] === "," || text[i] === "}" || i >= text.length) out.push({ key, value: null, spread: false }); // shorthand
    else { // method / computed: skip to the end of this entry
      const e = readExpr(text, i);
      out.push({ key, value: "(unknown)()", spread: false });
      i += Math.max(e.length, 1);
    }
  }
  return out;
}

// ---------- imports / modules ----------

interface ImportBinding { spec: string; imported: string } // imported: name | "default" | "*"

export function parseImports(src: string): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  for (const m of src.matchAll(/\bimport\s+(?!type\b)([^'"`;]+?)\s+from\s*['"]([^'"]+)['"]/g)) {
    let clause = m[1];
    const spec = m[2];
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) { map.set(ns[1], { spec, imported: "*" }); clause = clause.replace(ns[0], ""); }
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        if (!p) continue;
        const [a, b] = p.split(/\s+as\s+/);
        map.set((b ?? a).trim(), { spec, imported: a.trim() });
      }
      clause = clause.replace(named[0], "");
    }
    const def = clause.replace(/,/g, "").trim();
    if (/^[\w$]+$/.test(def)) map.set(def, { spec, imported: "default" });
  }
  return map;
}

const stripJsonc = (t: string) => t.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1");

interface Aliases { baseDir: string; paths: [string, string[]][] }
const aliasCache = new WeakMap<Reader, Map<string, Aliases | null>>();

function readTsconfig(reader: Reader, rel: string, depth = 0): { baseUrl?: string; paths?: Record<string, string[]>; dir: string; pathsDir: string } | null {
  const t = reader.read(rel);
  if (t === null) return null;
  let j: any;
  try { j = JSON.parse(stripJsonc(t)); } catch { return null; }
  const dir = posix.dirname(rel);
  const co = j?.compilerOptions ?? {};
  let out: { baseUrl?: string; paths?: Record<string, string[]>; dir: string; pathsDir: string } = { dir, pathsDir: dir };
  if (typeof j?.extends === "string" && j.extends.startsWith(".") && depth < 3) {
    let ext = posix.normalize(posix.join(dir, j.extends));
    if (!ext.endsWith(".json")) ext += ".json";
    const parent = readTsconfig(reader, ext, depth + 1);
    if (parent) out = { ...parent };
  }
  if (typeof co.baseUrl === "string") out.baseUrl = posix.normalize(posix.join(dir, co.baseUrl));
  if (co.paths && typeof co.paths === "object") { out.paths = co.paths; out.pathsDir = out.baseUrl ?? dir; }
  return out;
}

/** tsconfig/jsconfig `paths` aliases that apply to `file` (nearest config up the tree that defines them). */
export function aliasesFor(reader: Reader, file: string): Aliases | null {
  const key = reader.root ?? reader;
  let cache = aliasCache.get(key);
  if (!cache) { cache = new Map(); aliasCache.set(key, cache); }
  let dir = posix.dirname(file);
  const visited: string[] = [];
  let result: Aliases | null = null;
  for (;;) {
    if (cache.has(dir)) { result = cache.get(dir)!; break; }
    visited.push(dir);
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const p = dir === "." ? name : `${dir}/${name}`;
      const c = readTsconfig(reader, p);
      if (c?.paths) { result = { baseDir: c.pathsDir, paths: Object.entries(c.paths) }; break; }
    }
    if (result || dir === "." || dir === "/" || dir === "") break;
    dir = posix.dirname(dir);
  }
  for (const v of visited) cache.set(v, result);
  return result;
}

const CODE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".json", ".astro", ".vue", ".svelte", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.json"];

function pick(base: string, reader: Reader): string | null {
  const b = base.replace(/\.(?:m?js|jsx)$/, "");
  const cands = [base, ...CODE_EXTS.map((e) => b + e), ...CODE_EXTS.map((e) => base + e)];
  for (const c of cands) {
    if (/\.[a-z]+$/i.test(c) && reader.exists(c) && !/\/$/.test(c)) {
      // a directory named like `x.y` would "exist" too; require readable text
      if (reader.read(c) !== null) return c;
    }
  }
  return null;
}

/** Resolve an import specifier to a project file: relative paths, tsconfig/jsconfig `paths`, and the common `@/ ~/ $lib/` conventions. */
export function resolveModule(reader: Reader, from: string, spec: string): string | null {
  if (spec.startsWith(".")) return pick(posix.normalize(posix.join(posix.dirname(from), spec)), reader);
  const al = aliasesFor(reader, from);
  if (al) {
    for (const [pat, targets] of al.paths) {
      const star = pat.indexOf("*");
      let rest: string | null = null;
      if (star < 0) { if (spec === pat) rest = ""; }
      else if (spec.startsWith(pat.slice(0, star)) && spec.endsWith(pat.slice(star + 1)) && spec.length >= pat.length - 1) rest = spec.slice(star, spec.length - (pat.length - star - 1));
      if (rest === null) continue;
      for (const t of targets) {
        const target = star < 0 || !t.includes("*") ? t : t.replace("*", rest);
        const r = pick(posix.normalize(posix.join(al.baseDir, target)), reader);
        if (r) return r;
      }
    }
    // a matching alias means the spec is project-local; fall through to heuristics only if nothing matched
  }
  const m = /^(?:@|~|\$|#)[\w-]*\/(.*)$/.exec(spec);
  if (m) for (const b of [`src/${m[1]}`, m[1], `src/lib/${m[1]}`, `app/${m[1]}`]) { const r = pick(b, reader); if (r) return r; }
  return null;
}

// ---------- evaluation ----------

type Val =
  | { t: "str"; v: string; dyn: boolean }
  | { t: "nullish" }
  | { t: "obj"; text: string; file: string; src: string }
  | { t: "unknown" };

const UNKNOWN: Val = { t: "unknown" };
const MAX_DEPTH = 6;

/** The initialiser of `const name = …`. null when absent, or when `name` is declared more than once / with let|var (shadowing, reassignment → can't know). */
function findBinding(src: string, name: string): string | null {
  const n = name.replace(/\$/g, "\\$");
  const re = new RegExp(`(?:^|[^\\w$.])(const|let|var)\\s+${n}\\s*(?::[^=\\n]+?)?=(?!=)\\s*`, "g");
  const ms = [...src.matchAll(re)];
  if (ms.length !== 1 || ms[0][1] !== "const") return null;
  const m = ms[0];
  return readExpr(src, m.index! + m[0].length);
}
/** A name that is declared in a way we refuse to follow (let/var/duplicate): must resolve to "unknown", not fall through to other heuristics. */
function ambiguous(src: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  const ms = [...src.matchAll(new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${n}\\s*(?::[^=\\n]+?)?=(?!=)`, "g"))];
  return ms.length > 1 || (ms.length === 1 && !/(?:^|[^\w$.])const\s/.test(ms[0][0]));
}

function stripTs(e: string): string {
  let t = e.trim();
  for (;;) {
    const n = t.replace(/\s+(?:as\s+const|as\s+[\w.<>\[\]| ]+|satisfies\s+[\w.<>\[\]| ]+)$/, "").replace(/^\((.*)\)$/s, (m, g) => (skipBalanced(m, 0) === m.length ? g : m)).replace(/!$/, "").trim();
    if (n === t) return t;
    t = n;
  }
}

function destructuredDefault(src: string, name: string): { found: boolean; def?: string } {
  const pats = [
    /\b(?:const|let)\s*\{([^}]*)\}\s*(?::[^=]+)?=\s*(?:Astro\.props|props|\$props\(\)|defineProps[^;\n]*)/g,
    /\(\s*\{([^{}]*)\}\s*(?::\s*[^)]*)?\)/g,
  ];
  for (const re of pats) {
    for (const m of src.matchAll(re)) {
      for (const part of m[1].split(",")) {
        const mm = /^\s*([\w$]+)\s*(?::\s*([\w$]+))?\s*(?:=\s*([\s\S]+?))?\s*$/.exec(part);
        if (mm && (mm[2] ?? mm[1]) === name) return { found: true, def: mm[3] };
      }
    }
  }
  const ex = new RegExp(`\\bexport\\s+let\\s+${name}\\b(?:\\s*:\\s*[^=;\\n]+)?(?:\\s*=\\s*([^;\\n]+))?`).exec(src);
  if (ex) return { found: true, def: ex[1] };
  return { found: false };
}

const getProp = (rc: Rc, k: string): Presence | undefined => rc.props?.[k.toLowerCase()] ?? rc.props?.["*"];

function propVal(p: Presence | undefined): Val {
  if (p === undefined || p === "absent") return { t: "nullish" };
  return p === "empty" ? { t: "str", v: "", dyn: false } : { t: "str", v: "x", dyn: true };
}

function evalTemplate(raw: string, scope: { file: string; src: string }, rc: Rc, depth: number): Val {
  let out = "", dyn = false, unresolved = false;
  let i = 1;
  const end = raw.length - 1;
  while (i < end) {
    if (raw[i] === "\\") { out += raw[i + 1] ?? ""; i += 2; continue; }
    if (raw[i] === "$" && raw[i + 1] === "{") {
      const close = skipBalanced(raw, i + 1);
      const v = evalExpr(raw.slice(i + 2, close - 1), scope, rc, depth + 1);
      dyn = true;
      if (v.t === "str" && !v.dyn) out += v.v; else if (v.t === "nullish") out += ""; else { unresolved = true; if (v.t === "str") out += v.v; }
      i = close; continue;
    }
    out += raw[i++];
  }
  return { t: "str", v: out, dyn: dyn && unresolved };
}

function lookupMember(obj: Val, path: string[], rc: Rc, depth: number): Val {
  let cur = obj;
  for (const key of path) {
    if (cur.t === "nullish") return cur; // optional chaining / undefined access
    if (cur.t !== "obj") return UNKNOWN;
    const entries = parseObject(cur.text);
    const hit = [...entries].reverse().find((e) => !e.spread && e.key === key);
    const scope = { file: cur.file, src: cur.src };
    if (hit) cur = hit.value === null ? evalExpr(key, scope, rc, depth + 1) : evalExpr(hit.value, scope, rc, depth + 1);
    else if (entries.some((e) => e.spread)) return UNKNOWN;
    else return { t: "nullish" };
  }
  return cur;
}

function loadExport(file: string, name: string, rc: Rc, depth: number): Val {
  const src = rc.reader.read(file);
  if (src === null) return UNKNOWN;
  const scope = { file, src };
  if (file.endsWith(".json")) return name === "default" ? evalExpr(src, scope, rc, depth + 1) : UNKNOWN;
  if (name === "default") {
    const m = /\bexport\s+default\s+/.exec(src);
    if (!m) return UNKNOWN;
    return evalExpr(readExpr(src, m.index + m[0].length), scope, { ...rc, props: undefined }, depth + 1);
  }
  const expr = findBinding(src, name);
  if (expr !== null && new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b`).test(src)) return evalExpr(expr, scope, { ...rc, props: undefined }, depth + 1);
  const alias = new RegExp(`\\bexport\\s*\\{[^}]*\\b([\\w$]+)\\s+as\\s+${name}\\b[^}]*\\}`).exec(src)?.[1];
  if (alias) { const e = findBinding(src, alias); if (e !== null) return evalExpr(e, scope, { ...rc, props: undefined }, depth + 1); }
  if (new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src)) { const e = findBinding(src, name); if (e !== null) return evalExpr(e, scope, { ...rc, props: undefined }, depth + 1); }
  return UNKNOWN; // re-exports etc.: not followed
}

function evalIdent(path: string[], scope: { file: string; src: string }, rc: Rc, depth: number): Val {
  const [root, ...rest] = path;
  if (root === "undefined" && !rest.length) return { t: "nullish" };
  // wrapper props: `props.title`, `Astro.props.title`
  if (rc.props) {
    if (root === "props" && rest.length) return propVal(getProp(rc, rest[0]));
    if (root === "Astro" && rest[0] === "props" && rest.length > 1) return propVal(getProp(rc, rest[1]));
  }
  if (ambiguous(scope.src, root)) return UNKNOWN;
  const binding = findBinding(scope.src, root);
  if (binding !== null) {
    const v = evalExpr(binding, scope, rc, depth + 1);
    return lookupMember(v, rest, rc, depth);
  }
  if (rc.props) {
    const d = destructuredDefault(scope.src, root);
    if (d.found) {
      const given = getProp(rc, root);
      let v: Val;
      if (given !== undefined && given !== "absent") v = propVal(given);
      else v = d.def ? evalExpr(d.def, scope, rc, depth + 1) : { t: "nullish" };
      return lookupMember(v, rest, rc, depth);
    }
  }
  const imp = parseImports(scope.src).get(root);
  if (imp && depth < MAX_DEPTH) {
    const file = resolveModule(rc.reader, scope.file, imp.spec);
    if (!file) return UNKNOWN;
    if (imp.imported === "*") {
      if (!rest.length) return UNKNOWN;
      return lookupMember(loadExport(file, rest[0], rc, depth), rest.slice(1), rc, depth);
    }
    return lookupMember(loadExport(file, imp.imported, rc, depth), rest, rc, depth);
  }
  return UNKNOWN;
}

function evalExpr(raw: string, scope: { file: string; src: string }, rc: Rc, depth: number): Val {
  if (depth > MAX_DEPTH + 4) return UNKNOWN;
  const e = stripTs(raw);
  if (!e) return { t: "nullish" };
  const alt = splitTop(e, ["||", "??"]);
  if (alt) {
    for (let k = 0; k < alt.length; k++) {
      const v = evalExpr(alt[k], scope, rc, depth + 1);
      if (v.t === "unknown") return UNKNOWN;
      if (v.t === "obj" || (v.t === "str" && (v.v.trim() !== "" || v.dyn))) return v;
      if (k === alt.length - 1) return v;
    }
  }
  const q = e[0];
  if ((q === '"' || q === "'") && skipString(e, 0) === e.length) return { t: "str", v: e.slice(1, -1), dyn: false };
  if (q === "`" && skipString(e, 0) === e.length) return evalTemplate(e, scope, rc, depth);
  if (e === "undefined" || e === "null") return { t: "nullish" };
  if (q === "{" && skipBalanced(e, 0) === e.length) return { t: "obj", text: e, file: scope.file, src: scope.src };
  const pm = /^([A-Za-z_$][\w$]*)((?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\??\.?\[\s*(['"])[^'"]+\3\s*\])*)$/.exec(e);
  if (pm) {
    const path = [pm[1], ...[...pm[2].matchAll(/\??\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\]/g)].map((x) => x[1] ?? x[2])];
    return evalIdent(path, scope, rc, depth);
  }
  return UNKNOWN;
}

/** Presence of a JS expression as a title/description value. "unknown" → caller should treat as present. */
export function presenceOfExpr(expr: string, src: string, rc: Rc): Presence | "unknown" {
  let v: Val;
  try { v = evalExpr(expr, { file: rc.file, src }, rc, 0); } catch { return "unknown"; }
  if (v.t === "nullish") return "empty";
  if (v.t === "str") return v.v.trim() === "" && !v.dyn ? "empty" : "present";
  return "unknown";
}

/** Resolve an `import X from 'spec'` / `{ X }` binding name used as a component to its source file. */
export function resolveComponentFile(src: string, name: string, rc: Rc): string | null {
  const imp = parseImports(src).get(name);
  return imp ? resolveModule(rc.reader, rc.file, imp.spec) : null;
}
