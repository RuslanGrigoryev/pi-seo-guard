import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diffFile } from "../src/rules.ts";
import { checkWrite } from "../src/guard.ts";
import { scanProject } from "../src/scan.ts";
import { loadConfig, type SeoGuardConfig } from "../src/config.ts";
import { inlineIgnores } from "../src/ignore.ts";

const base: SeoGuardConfig = { ignore: [], rules: {} };
const withIgnore = (ignoreRules: SeoGuardConfig["ignoreRules"]): SeoGuardConfig => ({ ...base, ignoreRules });
const rules = (rel: string, b: string | null, a: string, c = base) => diffFile(rel, b, a, c).map((f) => f.rule);
const html = (extra = "") => `<html><head><title>T</title>${extra}</head><body><h1>x</h1></body></html>`;
const noidx = `<meta name="robots" content="noindex">`;

let dir: string;
const put = (rel: string, c: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), c); };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seo-ign-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config ignore entries", () => {
  it("baseline: noindex-added fires", () => expect(rules("public/staging/a.html", html(), html(noidx))).toContain("noindex-added"));
  it("rule + paths", () => {
    const c = withIgnore([{ rule: "noindex-added", paths: ["public/staging/**"] }]);
    expect(rules("public/staging/a.html", html(), html(noidx), c)).not.toContain("noindex-added");
    expect(rules("public/other/a.html", html(), html(noidx), c)).toContain("noindex-added");
  });
  it("rule + routes", () => {
    const c = withIgnore([{ rule: "noindex-added", routes: ["/staging/*"] }]);
    expect(rules("app/staging/deep/page.tsx", `export const metadata = { title: "T" }`, `export const metadata = { title: "T", robots: "noindex" }`, c)).not.toContain("noindex-added");
    expect(rules("app/live/page.tsx", `export const metadata = { title: "T" }`, `export const metadata = { title: "T", robots: "noindex" }`, c)).toContain("noindex-added");
  });
  it("no rule = all non-critical rules for the paths", () => {
    const c = withIgnore([{ paths: ["app/(internal)/**"] }]);
    const b = `export const metadata = { title: "T" }`;
    expect(rules("app/(internal)/x/page.tsx", b, `export const x = 1`, c)).toEqual([]);
    expect(rules("app/pub/page.tsx", b, `export const x = 1`, c)).toContain("title-removed");
  });
  it("critical rules are NOT covered by a wildcard entry", () => {
    const c = withIgnore([{ paths: ["**"] }, { routes: ["/**"] }]);
    expect(rules("robots.txt", "User-agent: *\nAllow: /", "User-agent: *\nDisallow: /", c)).toContain("robots-disallow-all");
    expect(rules("app/layout.tsx", `export const metadata = { title: "T" }`, `export const metadata = { title: "T", robots: "noindex" }`, c)).toContain("sitewide-noindex");
  });
  it("critical rule ignorable by explicit name", () => {
    const c = withIgnore([{ rule: "robots-disallow-all", paths: ["robots.txt"] }]);
    expect(rules("robots.txt", "User-agent: *\nAllow: /", "User-agent: *\nDisallow: /", c)).toEqual([]);
  });
  it("unknown rule name never widens to all", () => {
    const c = { ...base };
    writeFileSync(join(dir, ".seo-guard.json"), JSON.stringify({ ignore: [{ rule: "nope", paths: ["**"] }] }));
    expect(loadConfig(dir).config.ignoreRules ?? []).toEqual([]);
    expect(rules("a.html", html(), html(noidx), c)).toContain("noindex-added");
  });
});

describe("config loading", () => {
  it(".seo-guard.json merges with .pi/seo-guard.json", () => {
    put(".pi/seo-guard.json", JSON.stringify({ ignore: ["legacy/**"], rules: { "h1-removed": "off" }, baseUrl: "https://a.com" }));
    put(".seo-guard.json", JSON.stringify({ ignore: [{ rule: "noindex-added", routes: ["/staging/*"] }], rules: { "title-removed": "critical" } }));
    const { config, error } = loadConfig(dir);
    expect(error).toBeUndefined();
    expect(config.ignore).toEqual(["legacy/**"]);
    expect(config.ignoreRules).toEqual([{ rule: "noindex-added", routes: ["/staging/*"], paths: undefined }]);
    expect(config.rules).toEqual({ "h1-removed": "off", "title-removed": "critical" });
    expect(config.baseUrl).toBe("https://a.com");
  });
  it("invalid JSON in one file keeps the other", () => {
    put(".pi/seo-guard.json", "{nope");
    put(".seo-guard.json", JSON.stringify({ rules: { "h1-removed": "off" } }));
    const r = loadConfig(dir);
    expect(r.error).toMatch(/\.pi\/seo-guard\.json/);
    expect(r.config.rules["h1-removed"]).toBe("off");
  });
});

describe("inline comments", () => {
  it("html comment with rule", () => {
    const a = `<!-- seo-guard-ignore noindex-added -->${html(noidx)}`;
    expect(rules("a.html", html(), a)).not.toContain("noindex-added");
    expect(rules("a.html", html(), html(noidx))).toContain("noindex-added");
  });
  it("// and {/* */} forms, multiple rules", () => {
    const b = `export default () => <div><h1>x</h1></div>\nexport const metadata = { title: "T" }`;
    const a1 = `// seo-guard-ignore title-removed, h1-removed\nexport default () => <div/>\nexport const metadata = {}`;
    expect(rules("app/p/page.tsx", b, a1)).toEqual([]);
    const a2 = `export default () => <div>{/* seo-guard-ignore */}</div>\nexport const metadata = {}`;
    expect(rules("app/p/page.tsx", b, a2)).toEqual([]);
  });
  it("only the named rule is suppressed", () => {
    const b = `export default () => <h1>x</h1>\nexport const metadata = { title: "T" }`;
    const a = `// seo-guard-ignore h1-removed\nexport default () => <div/>\nexport const metadata = {}`;
    expect(rules("app/p/page.tsx", b, a)).toEqual(["title-removed"]);
  });
  it("bare ignore does not cover critical rules; named does", () => {
    const b = `export const metadata = { title: "T" }`;
    const a = (c: string) => `${c}\nexport const metadata = { title: "T", robots: "noindex" }`;
    expect(rules("app/layout.tsx", b, a("// seo-guard-ignore"))).toContain("sitewide-noindex");
    expect(rules("app/layout.tsx", b, a("// seo-guard-ignore noindex-added"))).toContain("sitewide-noindex");
    expect(rules("app/layout.tsx", b, a("// seo-guard-ignore sitewide-noindex"))).toEqual([]);
  });
  it("parser", () => {
    expect(inlineIgnores("<!-- seo-guard-ignore noindex-added -->").rules.has("noindex-added")).toBe(true);
    expect(inlineIgnores("// seo-guard-ignore").all).toBe(true);
    expect(inlineIgnores("nothing").all).toBe(false);
  });
});

describe("edit-time + scan", () => {
  it("checkWrite honours .seo-guard.json via loaded config", () => {
    put(".seo-guard.json", JSON.stringify({ ignore: [{ rule: "noindex-added", paths: ["public/staging/**"] }] }));
    put("public/staging/a.html", html());
    const cfg = loadConfig(dir).config;
    expect(checkWrite(dir, "write", { path: "public/staging/a.html", content: html(noidx) }, cfg)).toEqual([]);
    put("public/b.html", html());
    expect(checkWrite(dir, "write", { path: "public/b.html", content: html(noidx) }, cfg).map((f) => f.rule)).toContain("noindex-added");
  });
  it("scan honours ignore entries and inline comments", () => {
    put("app/page.tsx", `export default () => <h1>x</h1>`);
    put("app/(internal)/a/page.tsx", `export default () => <h1>x</h1>`);
    put("app/c/page.tsx", `// seo-guard-ignore missing-title, missing-description\nexport default () => <h1>x</h1>`);
    const cfg: SeoGuardConfig = { ...base, ignoreRules: [{ paths: ["app/(internal)/**"] }] };
    const files = scanProject(dir, cfg).findings.map((f) => f.file);
    expect(files).toContain("app/page.tsx");
    expect(files).not.toContain("app/(internal)/a/page.tsx");
    expect(files).not.toContain("app/c/page.tsx");
  });
  it("scan route-based ignore", () => {
    put("app/staging/a/page.tsx", `export default () => <h1>x</h1>`);
    const cfg = withIgnore([{ rule: "missing-title", routes: ["/staging/*"] }]);
    const r = scanProject(dir, cfg).findings.filter((f) => f.file.includes("staging"));
    expect(r.map((f) => f.rule)).toEqual(["missing-description"]);
  });
});
