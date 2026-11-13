import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatGithub, main, shouldFail } from "../src/cli.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
let dir: string;
const put = (p: string, c: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
const sh = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
const commit = (m: string) => { sh("add", "-A"); sh("commit", "-qm", m); };
const run = (argv: string[]) => { const out: string[] = [], err: string[] = []; const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, dir); return { code, out: out.join("\n"), err: err.join("\n") }; };

const page = (title: string) => `export const metadata = { title: ${JSON.stringify(title)}, description: "d" }\nexport default () => <h1>x</h1>\n`;

// CI sets GITHUB_BASE_REF on pull_request runs; the temp repos below have no origin.
const savedBaseRef = process.env.GITHUB_BASE_REF;
beforeEach(() => {
  delete process.env.GITHUB_BASE_REF;
  dir = mkdtempSync(join(tmpdir(), "seo-cli-"));
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@t.t"); sh("config", "user.name", "t");
  put("app/page.tsx", page("Home"));
  put("app/about/page.tsx", page("About"));
  put("app/layout.tsx", `export const metadata = { title: "Site" }\nexport default ({children}) => <html><body>{children}</body></html>\n`);
  put("public/robots.txt", "User-agent: *\nAllow: /\n");
  commit("init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedBaseRef === undefined) delete process.env.GITHUB_BASE_REF; else process.env.GITHUB_BASE_REF = savedBaseRef;
});

describe("pi-seo-guard check", () => {
  it("clean tree → exit 0", () => {
    const r = run(["check"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no SEO regressions/);
  });
  it("working-tree title removal is a warning: exit 0 by default, 1 with --fail-on warn", () => {
    put("app/about/page.tsx", `export const metadata = { description: "d" }\nexport default () => <h1>x</h1>\n`);
    const r = run(["check"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/title-removed/);
    expect(run(["check", "--fail-on", "warn"]).code).toBe(1);
    expect(run(["check", "--fail-on=none"]).code).toBe(0);
  });
  it("critical change fails by default (robots Disallow /)", () => {
    put("public/robots.txt", "User-agent: *\nDisallow: /\n");
    const r = run(["check"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/robots-disallow-all/);
  });
  it("--base compares against a ref across commits", () => {
    put("app/about/page.tsx", page(""));
    commit("empty title");
    expect(run(["check"]).out).toMatch(/no SEO regressions/); // HEAD vs working tree: nothing
    const r = run(["check", "--base", "HEAD~1"]);
    expect(r.out).toMatch(/title-removed \(app\/about\/page\.tsx\)/);
  });
  it("homepage deletion is critical; non-home deletion without redirect warns; with redirect is fine", () => {
    sh("rm", "-q", "app/page.tsx");
    let r = run(["check"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/homepage-removed/);
    sh("reset", "-q", "--hard");
    unlinkSync(join(dir, "app/about/page.tsx"));
    r = run(["check"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/route-removed.*\/about/);
    put("vercel.json", JSON.stringify({ redirects: [{ source: "/about", destination: "/", permanent: true }] }));
    expect(run(["check"]).out).not.toMatch(/route-removed/);
  });
  it("renamed file keeps comparing against the old content", () => {
    const body = Array.from({ length: 12 }, (_, i) => `// filler line ${i} that keeps similarity high`).join("\n");
    put("app/about/page.tsx", page("About") + body + "\n"); commit("grow");
    mkdirSync(join(dir, "app/info"), { recursive: true });
    renameSync(join(dir, "app/about/page.tsx"), join(dir, "app/info/page.tsx"));
    put("app/info/page.tsx", `export const metadata = { description: "d" }\nexport default () => <h1>x</h1>\n` + body + "\n"); // title dropped during the move
    commit("move");
    const r = run(["check", "--base", "HEAD~1"]);
    expect(r.out).toMatch(/title-removed \(app\/info\/page\.tsx\)/);
    expect(r.out).toMatch(/route-removed.*\/about/);
  });
  it("added files: only harmful-in-any-case directives (noindex layout)", () => {
    put("app/new/page.tsx", page("New"));
    expect(run(["check"]).out).toMatch(/no SEO regressions/);
    put("app/new/layout.tsx", `export const metadata = { robots: "noindex" }\n`);
    expect(run(["check"]).out).toMatch(/sitewide-noindex/);
  });
  it("follows indirection through git base (imported config emptied)", () => {
    put("config/site.ts", `export const siteConfig = { title: "Site" }\n`);
    put("app/page.tsx", `import { siteConfig } from "../config/site"\nexport const metadata = { title: siteConfig.title }\nexport default () => <h1>x</h1>\n`);
    commit("use config");
    put("config/site.ts", `export const siteConfig = { title: "" }\n`);
    put("app/page.tsx", `import { siteConfig } from "../config/site"\nexport const metadata = { title: siteConfig.title }\nexport default () => <h1>y</h1>\n`);
    expect(run(["check"]).out).toMatch(/title-removed \(app\/page\.tsx\)/);
  });
  it("respects .seo-guard.json ignore and inline comments", () => {
    put("public/robots.txt", "User-agent: *\nDisallow: /\n");
    put(".seo-guard.json", JSON.stringify({ ignore: [{ rule: "robots-disallow-all", paths: ["public/robots.txt"] }] }));
    expect(run(["check"]).code).toBe(0);
  });
  it("bad base ref → exit 2 with a hint", () => {
    const r = run(["check", "--base", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/cannot resolve base ref/);
  });
  it("--format json", () => {
    put("public/robots.txt", "User-agent: *\nDisallow: /\n");
    const j = JSON.parse(run(["check", "--format", "json"]).out);
    expect(j.findings[0]).toMatchObject({ rule: "robots-disallow-all", severity: "critical", file: "public/robots.txt", line: 2 });
  });
  it("--format github annotations", () => {
    put("public/robots.txt", "User-agent: *\nDisallow: /\n");
    put("app/about/page.tsx", `export const metadata = { description: "d" }\nexport default () => <h1>x</h1>\n`);
    const out = run(["check", "--format", "github"]).out;
    expect(out).toMatch(/^::error file=public\/robots\.txt,line=2,title=seo-guard%3A robots-disallow-all::/m);
    expect(out).toMatch(/^::warning file=app\/about\/page\.tsx,line=1,title=seo-guard%3A title-removed::/m);
  });
});

describe("pi-seo-guard scan + helpers", () => {
  it("scan reports and honours --fail-on", () => {
    put("app/bare/page.tsx", `export default () => <p>x</p>\n`);
    put("app/layout.tsx", `export default ({children}) => <html><body>{children}</body></html>\n`);
    const r = run(["scan"]);
    expect(r.out).toMatch(/missing-title/);
    expect(r.code).toBe(0);
    expect(run(["scan", "--fail-on", "warn"]).code).toBe(1);
  });
  it("usage / bad args", () => {
    expect(run([]).code).toBe(2);
    expect(run(["--help"]).code).toBe(0);
    expect(run(["check", "--format", "xml"]).code).toBe(2);
    expect(run(["frobnicate"]).code).toBe(2);
  });
  it("shouldFail + escaping", () => {
    const f = (severity: "critical" | "warn") => ({ rule: "title-removed" as const, severity, file: "a,b:c.tsx", message: "x\ny%", line: 3 });
    expect(shouldFail([f("warn")], "critical")).toBe(false);
    expect(shouldFail([f("critical")], "critical")).toBe(true);
    expect(shouldFail([f("warn")], "warn")).toBe(true);
    expect(shouldFail([f("critical")], "none")).toBe(false);
    expect(formatGithub([f("warn")])).toBe("::warning file=a%2Cb%3Ac.tsx,line=3,title=seo-guard%3A title-removed::x%0Ay%25");
  });
  it("runs as a real process (node strips types) and does not load Pi", () => {
    put("public/robots.txt", "User-agent: *\nDisallow: /\n");
    const r = spawnSync(process.execPath, [CLI, "check", "--format", "github"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/::error file=public\/robots\.txt/);
  });
});

describe("packaging", () => {
  it("action.yml pins the package version and package.json wires the bin", async () => {
    const { readFileSync } = await import("node:fs");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(readFileSync(join(root, "action.yml"), "utf8")).toContain(`pi-seo-guard@${pkg.version}`);
    expect(pkg.bin["pi-seo-guard"]).toBe("dist/cli.js");
    expect(pkg.scripts.prepack).toMatch(/build/);
  });
});
