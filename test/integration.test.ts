import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import seoGuard from "../src/index.ts";
import { loadConfig } from "../src/config.ts";
import { scanProject, formatScan } from "../src/scan.ts";
import { checkWrite, routeRemovalsFromBash, unredirectedRemovals, criticalRemovalFindings } from "../src/guard.ts";

let dir: string;
const put = (p: string, c: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
const page = (t: string, extra = "") => `<title>${t}</title><meta name="description" content="d"><link rel="canonical" href="/">${extra}<h1>x</h1>`;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seoguard-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config", () => {
  it("defaults when missing, parses when present, tolerates bad JSON", () => {
    expect(loadConfig(dir).config.ignore).toEqual([]);
    put(".pi/seo-guard.json", JSON.stringify({ ignore: ["legacy/**"], rules: { "h1-removed": "off", bogus: "off" }, baseUrl: "https://x.com" }));
    const c = loadConfig(dir).config;
    expect(c).toEqual({ ignore: ["legacy/**"], rules: { "h1-removed": "off" }, baseUrl: "https://x.com" });
    put(".pi/seo-guard.json", "{nope");
    expect(loadConfig(dir).error).toMatch(/Invalid/);
  });
  it("ignore globs skip files", () => {
    put("legacy/a.html", page("T"));
    const cfg = { ignore: ["legacy/**"], rules: {} };
    expect(checkWrite(dir, "write", { path: "legacy/a.html", content: "<p>x</p>" }, cfg)).toEqual([]);
    expect(checkWrite(dir, "write", { path: "other/a.html", content: "<p>x</p>" }, cfg)).toEqual([]); // new file, nothing to compare
    put("other/a.html", page("T"));
    expect(checkWrite(dir, "write", { path: "other/a.html", content: "<p>x</p>" }, cfg).length).toBeGreaterThan(0);
  });
});

describe("checkWrite (edit/write tool inputs)", () => {
  it("edit tool: applies edits virtually and diffs", () => {
    put("index.html", page("Home"));
    const f = checkWrite(dir, "edit", { path: "index.html", edits: [{ oldText: "<title>Home</title>", newText: "" }] }, { ignore: [], rules: {} });
    expect(f.map((x) => x.rule)).toEqual(["title-removed"]);
  });
  it("write tool to robots.txt", () => {
    const f = checkWrite(dir, "write", { path: "public/robots.txt", content: "User-agent: *\nDisallow: /" }, { ignore: [], rules: {} });
    expect(f[0].severity).toBe("critical");
  });
});

describe("route deletion", () => {
  beforeEach(() => {
    put("app/page.tsx", "export default ()=>null");
    put("app/about/page.tsx", "export default ()=>null");
    put("vercel.json", "{}");
  });
  const cfg = { ignore: [], rules: {} };
  it("deleting homepage is CRITICAL", () => {
    const rem = routeRemovalsFromBash(dir, "rm app/page.tsx", cfg);
    expect(criticalRemovalFindings(rem, cfg)[0].rule).toBe("homepage-removed");
  });
  it("directory removal finds nested routes", () => expect(routeRemovalsFromBash(dir, "rm -rf app/about", cfg).map((r) => r.route)).toEqual(["/about"]));
  it("post-delete: warns without redirect, silent with redirect", () => {
    const rem = routeRemovalsFromBash(dir, "rm -rf app/about", cfg);
    rmSync(join(dir, "app/about"), { recursive: true });
    expect(unredirectedRemovals(dir, rem, cfg).map((f) => f.rule)).toEqual(["route-removed"]);
    put("vercel.json", JSON.stringify({ redirects: [{ source: "/about", destination: "/", permanent: true }] }));
    expect(unredirectedRemovals(dir, rem, cfg)).toEqual([]);
  });
  it("rename (git mv) to a new route without redirect warns", () => {
    const rem = routeRemovalsFromBash(dir, "mv app/about app/company", cfg);
    rmSync(join(dir, "app/about"), { recursive: true }); put("app/company/page.tsx", "x");
    expect(unredirectedRemovals(dir, rem, cfg)[0].message).toMatch(/\/about/);
  });
  it("astro / sveltekit / nuxt file routing", () => {
    put("src/pages/index.astro", "x"); put("src/routes/a/+page.svelte", "x"); put("pages/b.vue", "x");
    expect(routeRemovalsFromBash(dir, "rm src/pages/index.astro src/routes/a/+page.svelte pages/b.vue", cfg).map((r) => r.route)).toEqual(["/", "/a", "/b"]);
  });
});

describe("/seo-guard scan", () => {
  it("reports each category", () => {
    execSync("git init -q && git config user.email a@b.c && git config user.name t", { cwd: dir });
    put("src/pages/index.astro", `<head>${page("Home")}</head><a href="/about">a</a><a href="/missing">b</a><a href="https://other.com/x">ext</a>`);
    put("src/pages/about.astro", `<h1>About</h1>`); // no title/desc/canonical
    put("src/pages/gone.astro", `<head>${page("Gone")}</head>`);
    put("public/sitemap.xml", `<urlset><url><loc>https://x.com/</loc></url></urlset>`);
    execSync("git add -A && git commit -qm init", { cwd: dir });
    execSync("rm src/pages/gone.astro", { cwd: dir });
    const r = scanProject(dir, { ignore: [], rules: {} });
    const by = (rule: string) => r.findings.filter((f) => f.rule === rule);
    expect(by("broken-link").map((f) => f.message)).toEqual([expect.stringContaining("/missing")]);
    expect(by("sitemap-missing-route").map((f) => f.file)).toEqual(["src/pages/about.astro"]);
    expect(by("route-removed")[0].message).toMatch(/\/gone/);
    expect(by("missing-title").map((f) => f.file)).toEqual(["src/pages/about.astro"]);
    expect(by("missing-description")).toHaveLength(1);
    expect(by("missing-canonical")).toHaveLength(1);
    expect(formatScan(r)).toMatch(/broken-link \(1\)/);
  });
  it("removed route covered by redirect isn't reported; rules off respected", () => {
    execSync("git init -q && git config user.email a@b.c && git config user.name t", { cwd: dir });
    put("src/pages/old.astro", page("O")); put("_redirects", "/old /new 301\n");
    execSync("git add -A && git commit -qm init", { cwd: dir });
    execSync("rm src/pages/old.astro", { cwd: dir });
    expect(scanProject(dir, { ignore: [], rules: {} }).findings.filter((f) => f.rule === "route-removed")).toEqual([]);
  });
});

describe("extension wiring (mock Pi API)", () => {
  function setup(hasUI: boolean, confirmAnswer = false) {
    const handlers: Record<string, Function> = {}; const cmds: Record<string, any> = {};
    seoGuard({ on: (e: string, h: Function) => (handlers[e] = h), registerCommand: (n: string, o: any) => (cmds[n] = o), sendMessage: () => {} } as any);
    const asked: string[] = [];
    const ctx = { cwd: dir, hasUI, ui: { confirm: async (_t: string, m: string) => { asked.push(m); return confirmAnswer; }, notify: () => {} } };
    return { handlers, cmds, ctx, asked };
  }
  const call = (toolName: string, input: any, id = "1") => ({ type: "tool_call", toolName, toolCallId: id, input });

  it("CRITICAL + headless → fail closed", async () => {
    const { handlers, ctx } = setup(false);
    const r = await handlers.tool_call(call("write", { path: "robots.txt", content: "User-agent: *\nDisallow: /" }), ctx);
    expect(r.block).toBe(true); expect(r.reason).toMatch(/failing closed/);
  });
  it("CRITICAL + UI: declined → block, approved → allowed", async () => {
    const no = setup(true, false);
    expect((await no.handlers.tool_call(call("write", { path: "robots.txt", content: "User-agent: *\nDisallow: /" }), no.ctx)).block).toBe(true);
    expect(no.asked[0]).toMatch(/Disallow/);
    const yes = setup(true, true);
    expect(await yes.handlers.tool_call(call("write", { path: "robots.txt", content: "User-agent: *\nDisallow: /" }), yes.ctx)).toBeUndefined();
  });
  it("WARN passes through and appends finding to the tool result", async () => {
    put("index.html", page("Home"));
    const { handlers, ctx } = setup(false);
    expect(await handlers.tool_call(call("edit", { path: "index.html", edits: [{ oldText: "<title>Home</title>", newText: "" }] }), ctx)).toBeUndefined();
    const res = await handlers.tool_result({ toolCallId: "1", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] }, ctx);
    expect(res.content).toHaveLength(2); expect(res.content[1].text).toMatch(/title-removed/);
  });
  it("bash rm of homepage: blocked headless", async () => {
    put("app/page.tsx", "x");
    const { handlers, ctx } = setup(false);
    expect((await handlers.tool_call(call("bash", { command: "rm app/page.tsx" }), ctx)).block).toBe(true);
  });
  it("unrelated tools / files untouched", async () => {
    const { handlers, ctx } = setup(false);
    expect(await handlers.tool_call(call("read", { path: "a" }), ctx)).toBeUndefined();
    expect(await handlers.tool_call(call("write", { path: "foo.py", content: "x" }), ctx)).toBeUndefined();
    expect(await handlers.tool_result({ toolCallId: "9", isError: false, content: [] }, ctx)).toBeUndefined();
  });
  it("registers /seo-guard", () => expect(setup(true).cmds["seo-guard"].handler).toBeTypeOf("function"));
});
