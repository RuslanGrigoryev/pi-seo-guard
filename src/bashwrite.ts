import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type SeoGuardConfig, severityOf } from "./config.ts";
import { matchesAny } from "./glob.ts";
import { type Finding, diffFile, isLayoutFile, isRootLayout } from "./rules.ts";
import { kindOf } from "./extract.ts";
import { fileToRoute, isRedirectConfig } from "./routes.ts";
import { isWatched } from "./guard.ts";
import { SKIP_DIRS, readText, rel } from "./fs.ts";

/**
 * Detects writes to SEO-relevant files made through the `bash` tool
 * (`sed -i`, `perl -pi`, `>` / `>>`, `tee`, `cp` / `mv` onto a file, `truncate`),
 * simulates the result where it can, and otherwise reports an "unverifiable" write.
 * Best-effort shell parsing: no variables, `$(…)`, globs or scripts.
 */

interface Tok { text: string; dyn: boolean; quoted: boolean }
interface Redir { fd: number; op: ">" | ">>"; target: Tok | null }
interface Stage { words: Tok[]; redirs: Redir[]; heredoc: { body: string; literal: boolean } | null }

const newStage = (): Stage => ({ words: [], redirs: [], heredoc: null });

export function parseCommand(cmd: string): Stage[][] {
  const stmts: Stage[][] = [];
  let pipe: Stage[] = [];
  let stage = newStage();
  let cur: string | null = null, dyn = false, quoted = false;
  type Pending = { t: "redir"; r: Redir } | { t: "heredoc"; strip: boolean } | { t: "skip" } | null;
  let pending: Pending = null;
  const here: { stage: Stage; delim: string; literal: boolean; strip: boolean }[] = [];

  const flush = () => {
    if (cur === null) return;
    const tok: Tok = { text: cur, dyn, quoted };
    cur = null; dyn = false; quoted = false;
    const p = pending; pending = null;
    if (!p) stage.words.push(tok);
    else if (p.t === "redir") p.r.target = tok;
    else if (p.t === "heredoc") here.push({ stage, delim: tok.text, literal: tok.quoted, strip: p.strip });
  };
  const endStage = (sep: ";" | "|") => {
    flush();
    pending = null;
    pipe.push(stage);
    stage = newStage();
    if (sep === ";") { stmts.push(pipe); pipe = []; }
  };
  const add = (s: string) => { cur = (cur ?? "") + s; };

  const n = cmd.length;
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    if (c === "\\") {
      if (cmd[i + 1] === "\n") { i += 2; continue; }
      add(cmd[i + 1] ?? ""); quoted = true; i += 2; continue;
    }
    if (c === "'") {
      let j = cmd.indexOf("'", i + 1); if (j < 0) j = n;
      add(cmd.slice(i + 1, j)); quoted = true; i = j + 1; continue;
    }
    if (c === '"') {
      i++; add(""); quoted = true;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < n && '$"`\\\n'.includes(cmd[i + 1])) { if (cmd[i + 1] !== "\n") add(cmd[i + 1]); i += 2; continue; }
        if (cmd[i] === "$" || cmd[i] === "`") dyn = true;
        add(cmd[i]); i++;
      }
      i++; continue;
    }
    if (c === "$" || c === "`" || c === "*" || c === "?" || c === "[" || (c === "~" && cur === null)) { dyn = true; add(c); i++; continue; }
    if (c === "#" && cur === null) { while (i < n && cmd[i] !== "\n") i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { flush(); i++; continue; }
    if (c === "\n") {
      endStage(";"); i++;
      for (const h of here.splice(0)) {
        const lines: string[] = [];
        while (i < n) {
          let e = cmd.indexOf("\n", i); if (e < 0) e = n;
          const line = cmd.slice(i, e); i = e + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(h.strip ? line.replace(/^\t+/, "") : line);
        }
        h.stage.heredoc = { body: lines.length ? lines.join("\n") + "\n" : "", literal: h.literal };
      }
      continue;
    }
    if (c === ";" || c === "(" || c === ")") { endStage(";"); i++; continue; }
    if (c === "&") {
      if (cmd[i + 1] === ">") { flush(); i += 2; const r: Redir = { fd: 1, op: ">", target: null }; if (cmd[i] === ">") { r.op = ">>"; i++; } stage.redirs.push(r); pending = { t: "redir", r }; continue; }
      endStage(";"); i += cmd[i + 1] === "&" ? 2 : 1; continue;
    }
    if (c === "|") {
      if (cmd[i + 1] === "|") { endStage(";"); i += 2; } else { endStage("|"); i += cmd[i + 1] === "&" ? 2 : 1; }
      continue;
    }
    if (c === "<") {
      flush();
      if (cmd[i + 1] === "<") {
        if (cmd[i + 2] === "<") { i += 3; pending = { t: "skip" }; }
        else { i += 2; const strip = cmd[i] === "-"; if (strip) i++; pending = { t: "heredoc", strip }; }
      } else { i++; pending = { t: "skip" }; }
      continue;
    }
    if (c === ">") {
      let fd = 1;
      if (cur !== null && /^\d+$/.test(cur) && !quoted) { fd = Number(cur); cur = null; dyn = false; } else flush();
      i++;
      let op: ">" | ">>" = ">";
      if (cmd[i] === ">") { op = ">>"; i++; }
      if (cmd[i] === "&") { i++; pending = { t: "skip" }; continue; }
      if (cmd[i] === "|") i++;
      const r: Redir = { fd, op, target: null };
      stage.redirs.push(r); pending = { t: "redir", r };
      continue;
    }
    add(c); i++;
  }
  endStage(";");
  return stmts.filter((p) => p.some((s) => s.words.length || s.redirs.length));
}

const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "nohup", "time", "nice"]);
function cmdOf(stage: Stage): Tok[] {
  let w = stage.words;
  for (;;) {
    if (w.length && !w[0].quoted && /^[A-Za-z_]\w*=/.test(w[0].text)) { w = w.slice(1); continue; }
    if (w.length && WRAPPERS.has(w[0].text)) { w = w.slice(1); continue; }
    if (w.length && w[0].text === "env") { w = w.slice(1); while (w.length && /^-/.test(w[0].text)) w = w.slice(1); continue; }
    break;
  }
  return w;
}

// ---- output simulation for echo / printf / cat ----

function printfOut(fmt: string, args: string[]): string | null {
  const segs: (string | "S")[] = [];
  let lit = "";
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "\\") {
      const d = fmt[++i];
      if (d === undefined || !"ntr\\\"'".includes(d)) return null;
      lit += d === "n" ? "\n" : d === "t" ? "\t" : d === "r" ? "\r" : d;
    } else if (c === "%") {
      const d = fmt[++i];
      if (d === "%") lit += "%";
      else if (d === "s") { segs.push(lit); lit = ""; segs.push("S"); }
      else return null;
    } else lit += c;
  }
  segs.push(lit);
  const slots = segs.filter((x) => x === "S").length;
  const pass = (a: string[]) => { let k = 0, o = ""; for (const s of segs) o += s === "S" ? (a[k++] ?? "") : s; return o; };
  if (!slots) return pass([]);
  let out = "", p = 0;
  do { out += pass(args.slice(p, p + slots)); p += slots; } while (p < args.length);
  return out;
}

function catFiles(cwd: string, args: Tok[]): string | null {
  let out = "";
  for (const a of args) {
    if (a.dyn || /^-/.test(a.text)) return null;
    const t = readText(resolve(cwd, a.text));
    if (t === null) return null;
    out += t;
  }
  return out;
}

function computeOut(cwd: string, words: Tok[], stdin: string | null): string | null {
  if (!words.length) return "";
  const name = basename(words[0].text), args = words.slice(1);
  if (name === ":" || name === "true") return "";
  if (name === "echo") {
    let nl = true, esc = false, k = 0;
    while (k < args.length && !args[k].quoted && /^-[neE]+$/.test(args[k].text)) {
      if (args[k].text.includes("n")) nl = false;
      if (args[k].text.includes("e")) esc = true;
      k++;
    }
    const rest = args.slice(k);
    if (rest.some((t) => t.dyn)) return null;
    let text = rest.map((t) => t.text).join(" ");
    if (esc) text = text.replace(/\\(n|t|\\)/g, (_m, x) => (x === "n" ? "\n" : x === "t" ? "\t" : "\\"));
    return text + (nl ? "\n" : "");
  }
  if (name === "printf") {
    if (!args.length || args.some((t) => t.dyn)) return null;
    return printfOut(args[0].text, args.slice(1).map((t) => t.text));
  }
  if (name === "cat") return args.length ? catFiles(cwd, args) : stdin;
  if (name === "tee") return stdin;
  return null;
}

// ---- sed / perl script simulation ----

interface Subst { re: RegExp; global: boolean; repl: (m: RegExpExecArray) => string }

const POSIX: Record<string, string> = { alpha: "a-zA-Z", digit: "0-9", alnum: "a-zA-Z0-9", upper: "A-Z", lower: "a-z", space: "\\s", blank: " \\t", punct: "!-\\/:-@\\[-`{-~", xdigit: "0-9a-fA-F" };

/** POSIX BRE/ERE → JS regex source. Returns null if unsupported. */
export function posixToJs(src: string, ere: boolean): string | null {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "[") {
      let j = i + 1, body = "";
      if (src[j] === "^") { body = "^"; j++; }
      if (src[j] === "]") { body += "\\]"; j++; }
      for (; j < src.length && src[j] !== "]"; j++) {
        if (src[j] === "[" && src[j + 1] === ":") {
          const e = src.indexOf(":]", j);
          const cls = POSIX[src.slice(j + 2, e)];
          if (e < 0 || !cls) return null;
          body += cls; j = e + 1;
        } else if (src[j] === "[" ) body += "\\[";
        else if (src[j] === "\\") body += "\\\\";
        else body += src[j];
      }
      if (j >= src.length) return null;
      out += "[" + body + "]"; i = j; continue;
    }
    if (c === "\\") {
      const d = src[++i];
      if (d === undefined) return null;
      if (!ere && "(){}|+?".includes(d)) out += d;
      else if (d === "<" || d === ">") out += "\\b";
      else if (/[1-9]/.test(d)) out += "\\" + d;
      else if ("nt.*[]^$\\/-wWsSbB".includes(d) || (ere && "(){}|+?".includes(d))) out += "\\" + d;
      else out += d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (!ere && "(){}|+?".includes(c)) { out += "\\" + c; continue; }
    out += c;
  }
  return out;
}

function parseSubsts(script: string, lang: "sed" | "perl", ere: boolean): Subst[] | null {
  const out: Subst[] = [];
  let i = 0;
  const n = script.length;
  const readPart = (d: string): string | null => {
    let s = "";
    for (; i < n; i++) {
      if (script[i] === "\\" && i + 1 < n) {
        if (script[i + 1] === d) { s += d === "/" ? "\\/" : d; i++; continue; }
        s += script[i] + script[i + 1]; i++; continue;
      }
      if (script[i] === d) { i++; return s; }
      s += script[i];
    }
    return null;
  };
  for (;;) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) break;
    if (script[i] !== "s") return null;
    const d = script[++i];
    if (!d || !"/#,:@!_".includes(d)) return null;
    i++;
    const pat = readPart(d), rep = pat === null ? null : readPart(d);
    if (pat === null || rep === null || pat === "") return null;
    let flags = "";
    while (i < n && /[a-zA-Z0-9]/.test(script[i])) flags += script[i++];
    if (/[^gIi]/.test(flags)) return null;
    const jsSrc = lang === "sed" ? posixToJs(pat, ere) : pat;
    if (jsSrc === null) return null;
    let re: RegExp;
    try { re = new RegExp(jsSrc, (/[Ii]/.test(flags) ? "i" : "") + "g"); } catch { return null; }
    // replacement template
    const parts: (string | number | "&")[] = [];
    let lit = "";
    const pushLit = () => { if (lit) parts.push(lit); lit = ""; };
    for (let k = 0; k < rep.length; k++) {
      const c = rep[k];
      if (c === "\\") {
        const e = rep[++k];
        if (e === undefined) return null;
        if (/[1-9]/.test(e)) { pushLit(); parts.push(Number(e)); }
        else if (e === "n") lit += "\n";
        else if (e === "t") lit += "\t";
        else if (/[ULEulQ]/.test(e) && lang === "sed") return null;
        else lit += e;
      } else if (lang === "sed" && c === "&") { pushLit(); parts.push("&"); }
      else if (lang === "perl" && c === "$") {
        const m = /^\$(?:(\d)|\{(\d)\}|&)/.exec(rep.slice(k));
        if (!m) return null;
        pushLit(); parts.push(m[1] || m[2] ? Number(m[1] ?? m[2]) : "&"); k += m[0].length - 1;
      } else if (lang === "perl" && c === "@") return null;
      else lit += c;
    }
    pushLit();
    out.push({ re, global: flags.includes("g"), repl: (m) => parts.map((p) => (p === "&" ? m[0] : typeof p === "number" ? (m[p] ?? "") : p)).join("") });
  }
  return out.length ? out : null;
}

function applySubsts(text: string, subs: Subst[]): string {
  return text.split("\n").map((line) => {
    for (const s of subs) {
      s.re.lastIndex = 0;
      let done = false;
      line = line.replace(s.re, (...a) => {
        if (done && !s.global) return a[0];
        done = true;
        const groups = a.slice(0, a.findIndex((x) => typeof x === "number"));
        return s.repl(groups as unknown as RegExpExecArray);
      });
    }
    return line;
  }).join("\n");
}

interface InPlace { files: Tok[]; edit: (before: string) => string | null }

function sedInPlace(args: Tok[]): InPlace | null {
  let inplace = false, ere = false, bad = false;
  const scripts: string[] = [];
  const rest: Tok[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k].text;
    if (a === "--") { rest.push(...args.slice(k + 1)); break; }
    if (a === "--in-place" || a.startsWith("--in-place=")) { inplace = true; continue; }
    if (a === "--regexp-extended") { ere = true; continue; }
    if (a === "--expression") { scripts.push(args[++k]?.text ?? ""); continue; }
    if (a.startsWith("--expression=")) { scripts.push(a.slice(13)); continue; }
    if (a.startsWith("--")) { bad = true; continue; }
    if (/^-[a-zA-Z]/.test(a) && !args[k].quoted) {
      for (let c = 1; c < a.length; c++) {
        const f = a[c];
        if (f === "i") { inplace = true; break; }
        if (f === "e") { scripts.push(a.length > c + 1 ? a.slice(c + 1) : args[++k]?.text ?? ""); break; }
        if (f === "E" || f === "r") ere = true;
        else if (f === "s" || f === "u") continue;
        else bad = true;
      }
      if (inplace && a === "-i" && args[k + 1] && args[k + 1].text === "" && args[k + 1].quoted) k++; // BSD: -i ''
      continue;
    }
    rest.push(args[k]);
  }
  if (!inplace) return null;
  if (!scripts.length && rest.length) scripts.push(rest.shift()!.text);
  const subs = bad || !scripts.length ? null : parseSubsts(scripts.join("\n"), "sed", ere);
  return { files: rest, edit: (b) => (subs ? applySubsts(b, subs) : null) };
}

function perlInPlace(args: Tok[]): InPlace | null {
  let inplace = false, p = false, bad = false;
  const scripts: string[] = [];
  const rest: Tok[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k].text;
    if (/^-[a-zA-Z0-9.]/.test(a) && !args[k].quoted) {
      for (let c = 1; c < a.length; c++) {
        const f = a[c];
        if (f === "i") { inplace = true; break; }
        if (f === "e") { scripts.push(a.length > c + 1 ? a.slice(c + 1) : args[++k]?.text ?? ""); break; }
        if (f === "p") p = true; else bad = true;
      }
      continue;
    }
    rest.push(args[k]);
  }
  if (!inplace) return null;
  const subs = bad || !p || !scripts.length ? null : parseSubsts(scripts.join("\n"), "perl", true);
  return { files: rest, edit: (b) => (subs ? applySubsts(b, subs) : null) };
}

// ---- ops ----

type Op =
  | { kind: "set" | "append"; path: Tok; content: string | null }
  | { kind: "edit"; path: Tok; edit: (before: string) => string | null }
  | { kind: "copy"; src: Tok; dest: Tok };

function collectOps(cwd: string, cmd: string, depth = 0): Op[] {
  const ops: Op[] = [];
  for (const pipe of parseCommand(cmd)) {
    let prevOut: string | null = null;
    pipe.forEach((stage, idx) => {
      const words = cmdOf(stage);
      const name = words.length ? basename(words[0].text) : "";
      const args = words.slice(1);
      const hd = stage.heredoc;
      const stdin: string | null = hd ? (hd.literal || !/[$`]/.test(hd.body) ? hd.body : null) : idx > 0 ? prevOut : null;
      const out = computeOut(cwd, words, stdin);
      for (const r of stage.redirs) if (r.fd === 1 && r.target) ops.push({ kind: r.op === ">" ? "set" : "append", path: r.target, content: out });
      const nonFlags = args.filter((t) => !/^-/.test(t.text) || t.quoted);
      if (name === "tee") {
        const append = args.some((t) => /^-[a-z]*a/.test(t.text) || t.text === "--append");
        for (const f of nonFlags) ops.push({ kind: append ? "append" : "set", path: f, content: stdin });
      } else if (name === "sed" || name === "perl") {
        const ip = name === "sed" ? sedInPlace(args) : perlInPlace(args);
        if (ip) for (const f of ip.files) ops.push({ kind: "edit", path: f, edit: ip.edit });
      } else if ((name === "cp" || name === "mv") && !args.some((t) => /^(?:-t|--target-directory)/.test(t.text))) {
        if (nonFlags.length >= 2) { const dest = nonFlags[nonFlags.length - 1]; for (const src of nonFlags.slice(0, -1)) ops.push({ kind: "copy", src, dest }); }
      } else if (name === "truncate") {
        let size: string | null = null;
        const files: Tok[] = [];
        for (let k = 0; k < args.length; k++) {
          const a = args[k].text;
          if (a === "-s" || a === "--size") size = args[++k]?.text ?? null;
          else if (a.startsWith("--size=")) size = a.slice(7);
          else if (/^-s./.test(a)) size = a.slice(2);
          else if (/^-/.test(a)) continue;
          else files.push(args[k]);
        }
        for (const f of files) ops.push({ kind: "set", path: f, content: size === "0" ? "" : null });
      } else if ((name === "bash" || name === "sh" || name === "zsh") && depth < 3) {
        const k = args.findIndex((t) => /^-[a-z]*c$/.test(t.text));
        if (k >= 0 && args[k + 1] && !args[k + 1].dyn) ops.push(...collectOps(cwd, args[k + 1].text, depth + 1));
      }
      prevOut = name === "tee" ? stdin : out;
    });
  }
  return ops;
}

interface FileState { r: string; before: string | null; cur: string | null; unknown: boolean }

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function critical(r: string) { return basename(r) === "robots.txt" || isRootLayout(r); }
function warnEligible(r: string) {
  const name = basename(r);
  return name === "sitemap.xml" || isRedirectConfig(r) || isLayoutFile(r) || fileToRoute(r) !== null || kindOf(r) === "html";
}

/** SEO findings for writes a bash command makes to watched files. */
export function bashWriteFindings(cwd: string, command: string, cfg: SeoGuardConfig): Finding[] {
  if (!/[>]|\btee\b|\bsed\b|\bperl\b|\bcp\b|\bmv\b|\btruncate\b|\b(?:ba|z)?sh\b/.test(command)) return [];
  const ops = collectOps(cwd, command);
  if (!ops.length) return [];
  const states = new Map<string, FileState>();

  const watched = (t: Tok): { abs: string; r: string } | null => {
    if (t.dyn || !t.text) return null;
    const abs = isAbsolute(t.text) ? t.text : resolve(cwd, t.text);
    const r = rel(cwd, abs);
    if (!r || r.startsWith("..") || isAbsolute(r) || matchesAny(cfg.ignore, r) || r.split("/").some((s) => SKIP_DIRS.has(s))) return null;
    return { abs, r };
  };
  const stateFor = (abs: string, r: string): FileState => {
    let s = states.get(abs);
    if (!s) {
      const exists = existsSync(abs) && !isDir(abs);
      const text = exists ? readText(abs) : null;
      s = { r, before: text, cur: text, unknown: exists && text === null };
      states.set(abs, s);
    }
    return s;
  };

  for (const op of ops) {
    if (op.kind === "copy") {
      const d0 = watched(op.dest), sp = op.src.dyn ? null : resolve(cwd, op.src.text);
      if (!d0 || !sp) continue;
      let abs = d0.abs;
      if (op.dest.text.endsWith("/") || isDir(abs)) abs = join(abs, basename(op.src.text));
      const r = rel(cwd, abs);
      if (!isWatched(r)) continue;
      const st = stateFor(abs, r);
      const known = states.get(sp);
      if (known) { if (known.unknown) st.unknown = true; else { st.cur = known.cur; st.unknown = false; } continue; }
      if (!existsSync(sp)) continue; // command would fail
      if (isDir(sp)) { st.unknown = true; continue; }
      const t = readText(sp);
      if (t === null) st.unknown = true; else { st.cur = t; st.unknown = false; }
      continue;
    }
    const w = watched(op.path);
    if (!w || !isWatched(w.r)) continue;
    const st = stateFor(w.abs, w.r);
    if (op.kind === "set") { if (op.content === null) st.unknown = true; else { st.cur = op.content; st.unknown = false; } }
    else if (op.kind === "append") { if (!st.unknown) { if (op.content === null) st.unknown = true; else st.cur = (st.cur ?? "") + op.content; } }
    else if (op.kind === "edit" && !st.unknown && st.cur !== null) { const res = op.edit(st.cur); if (res === null) st.unknown = true; else st.cur = res; }
  }

  const out: Finding[] = [];
  for (const st of states.values()) {
    if (st.unknown) {
      const crit = critical(st.r);
      if (!crit && !warnEligible(st.r)) continue;
      const rule = crit ? "unverifiable-critical-write" : "unverifiable-write";
      const severity = severityOf(cfg, rule);
      if (severity === "off") continue;
      out.push({ rule, severity, file: st.r, message: `A bash command modifies \`${st.r}\` in a way pi-seo-guard cannot simulate (sed/perl/redirect/cp/tee…), so the result can't be checked for ${crit ? "site-wide de-indexing or crawl blocking" : "SEO regressions"}. Prefer the edit/write tools for SEO files.` });
    } else if (st.cur !== null && st.cur !== st.before) out.push(...diffFile(st.r, st.before, st.cur, cfg));
  }
  return out;
}

