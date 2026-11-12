import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import seoGuard from "../src/index.ts";
import { diffFile } from "../src/rules.ts";
import { checkWrite, snapshotRoutes, snapshotRemovalFindings } from "../src/guard.ts";
import { SeoLedger } from "../src/ledger.ts";
import { scanProject } from "../src/scan.ts";
import type { SeoGuardConfig } from "../src/config.ts";

const cfg: SeoGuardConfig = { ignore: [], rules: {} };
const r = (rel: string, b: string | null, a: string, c = cfg) => diffFile(rel, b, a, c).map((f) => `${f.severity}:${f.rule}`);
let dir: string;
const put = (p: string, c: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seoguard2-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("1. SEO components / props", () => {
  it("NextSeo title/description/canonical removed or emptied", () => {
    const b = `export default () => <><NextSeo title="T" description="D" canonical="https://x.com/" /><h1>x</h1></>`;
    expect(r("pages/a.tsx", b, b.replace(' title="T"', ""))).toEqual(["warn:title-removed"]);
    expect(r("pages/a.tsx", b, b.replace('title="T"', 'title=""'))).toEqual(["warn:title-removed"]);
    expect(r("pages/a.tsx", b, b.replace(' description="D"', ""))).toEqual(["warn:description-removed"]);
    expect(r("pages/a.tsx", b, b.replace(' canonical="https://x.com/"', ""))).toEqual(["warn:canonical-removed"]);
  });
  it("noindex prop → critical (NextSeo, SEO, Layout)", () => {
    const b = `<NextSeo title="T" />`;
    expect(r("pages/a.tsx", b, `<NextSeo title="T" noindex />`)).toEqual(["critical:component-noindex"]);
    expect(r("pages/a.tsx", b, `<NextSeo title="T" noindex={true} />`)).toEqual(["critical:component-noindex"]);
    expect(r("pages/a.tsx", b, `<NextSeo title="T" noindex={false} />`)).toEqual([]);
    expect(r("src/pages/a.astro", `<Layout title="T"/>`, `<Layout title="T" noindex/>`)).toEqual(["critical:component-noindex"]);
  });
  it("generic <SEO|Seo|Head|Meta title=…>", () => {
    for (const C of ["SEO", "Seo", "Head", "Meta"])
      expect(r("src/Page.tsx", `<${C} title="T" description="d"/>`, `<${C} description="d"/>`)).toEqual(["warn:title-removed"]);
  });
  it("Astro layout props", () => {
    const b = `---\nimport L from "../layouts/Base.astro";\n---\n<L title="Home" description="d"><h1>x</h1></L>`.replace(/<L/g, "<Layout").replace("</L>", "</Layout>");
    expect(r("src/pages/a.astro", b, b.replace(' title="Home"', ""))).toEqual(["warn:title-removed"]);
    expect(r("src/pages/a.astro", b, b.replace(' description="d"', ""))).toEqual(["warn:description-removed"]);
    expect(r("src/pages/a.astro", b, b.replace("Home", "Home 2"))).toEqual([]);
  });
  it("Nuxt useHead / useSeoMeta", () => {
    const b = `<script setup>\nuseSeoMeta({ title: 'T', description: 'D' })\n</script><template><h1>x</h1></template>`;
    expect(r("pages/a.vue", b, b.replace("title: 'T', ", ""))).toEqual(["warn:title-removed"]);
    const h = `<script setup>\nuseHead({ title: 'T', meta: [{ name: 'description', content: 'D' }] })\n</script><template><h1>x</h1></template>`;
    expect(r("pages/a.vue", h, h.replace("content: 'D'", "content: ''"))).toEqual(["warn:description-removed"]);
    expect(r("pages/a.vue", h, h.replace("meta: [{ name: 'description', content: 'D' }]", "meta: [{ name: 'robots', content: 'noindex' }]"))).toContain("warn:noindex-added");
  });
  it("SvelteKit <svelte:head>", () => {
    const b = `<svelte:head><title>T</title><meta name="description" content="D"></svelte:head><h1>x</h1>`;
    expect(r("src/routes/a/+page.svelte", b, b.replace("<title>T</title>", ""))).toEqual(["warn:title-removed"]);
    expect(r("src/routes/a/+page.svelte", b, b.replace('content="D"', 'content=""'))).toEqual(["warn:description-removed"]);
  });
  it("Remix meta export", () => {
    const b = `export const meta = () => [{ title: "T" }, { name: "description", content: "D" }];`;
    expect(r("app/routes/a.tsx", b, b.replace('{ title: "T" }, ', ""))).toEqual(["warn:title-removed"]);
    expect(r("app/routes/a.tsx", b, b.replace('content: "D"', 'content: ""'))).toEqual(["warn:description-removed"]);
    expect(r("app/routes/a.tsx", b, b.replace("{ name: \"description\", content: \"D\" }", "{ name: \"robots\", content: \"noindex\" }"))).toContain("warn:noindex-added");
  });
});

describe("2. layout inheritance ledger", () => {
  const edit = (l: SeoLedger, rel: string, before: string | null, after: string) => l.observe(dir, rel, after, diffFile(rel, before, after, cfg));
  it("moving a title page → layout (app router) isn't a removal, either order", () => {
    const page = `export const metadata = { title: "T" };\nexport default () => <h1>x</h1>`;
    const lay = `export default ({children}) => <html><body>{children}</body></html>`;
    put("app/blog/page.tsx", page); put("app/layout.tsx", lay);
    const l1 = new SeoLedger();
    expect(edit(l1, "app/layout.tsx", lay, `export const metadata = { title: "T" };\n` + lay)).toEqual([]);
    expect(edit(l1, "app/blog/page.tsx", page, `export default () => <h1>x</h1>`)).toEqual([]);
    const l2 = new SeoLedger(); // page first, then layout → earlier warning resolved
    const f = edit(l2, "app/blog/page.tsx", page, `export default () => <h1>x</h1>`);
    expect(f.map((x) => x.rule)).toEqual(["title-removed"]);
    edit(l2, "app/layout.tsx", lay, `export const metadata = { title: "T" };\n` + lay);
    expect(l2.drainNotes()[0]).toMatch(/resolved/);
  });
  it("unrelated file's title doesn't suppress", () => {
    const l = new SeoLedger();
    put("app/a/page.tsx", "x"); put("app/b/page.tsx", "x");
    edit(l, "app/b/page.tsx", null, `export const metadata = { title: "B" };`);
    expect(edit(l, "app/a/page.tsx", `export const metadata = { title: "A" };`, `export default () => null`).map((x) => x.rule)).toEqual(["title-removed"]);
  });
  it("Astro: moving title from page to imported layout", () => {
    const page = `---\nimport Base from "../layouts/Base.astro";\n---\n<Base><title>T</title><h1>x</h1></Base>`;
    const lay = `<html><head></head><body><slot/></body></html>`;
    put("src/pages/a.astro", page); put("src/layouts/Base.astro", lay);
    const l = new SeoLedger();
    expect(edit(l, "src/layouts/Base.astro", lay, `<html><head><title>T</title></head><body><slot/></body></html>`)).toEqual([]);
    expect(edit(l, "src/pages/a.astro", page, page.replace("<title>T</title>", ""))).toEqual([]);
  });
  it("wired through checkWrite", () => {
    put("app/page.tsx", `export const metadata = { title: "T" };`); put("app/layout.tsx", "export default () => null");
    const l = new SeoLedger();
    expect(checkWrite(dir, "write", { path: "app/layout.tsx", content: `export const metadata = { title: "T" };` }, cfg, l)).toEqual([]);
    expect(checkWrite(dir, "write", { path: "app/page.tsx", content: `export default () => null` }, cfg, l)).toEqual([]);
  });
  it("/seo-guard: nested app-router layout title, no false 'missing title'", () => {
    put("app/layout.tsx", `export const metadata = { title: "S", description: "d", alternates: { canonical: "/" } };`);
    put("app/blog/page.tsx", `export default () => <h1>x</h1>`);
    expect(scanProject(dir, cfg).findings.filter((f) => f.rule.startsWith("missing"))).toEqual([]);
    put("app/blog/page.tsx", `export default () => <h1>x</h1>`);
    rmSync(join(dir, "app/layout.tsx"));
    put("app/other/layout.tsx", `export const metadata = { title: "S" };`);
    expect(scanProject(dir, cfg).findings.some((f) => f.rule === "missing-title" && f.file === "app/blog/page.tsx")).toBe(true);
  });
  it("/seo-guard: Astro page importing a layout with the title", () => {
    put("src/layouts/Base.astro", `<html><head><title>{title}</title><meta name="description" content="d"><link rel="canonical" href="/"></head></html>`);
    put("src/layouts/Other.astro", `<html><head></head></html>`);
    put("src/pages/a.astro", `---\nimport Base from "../layouts/Base.astro";\n---\n<Base><h1>x</h1></Base>`);
    put("src/pages/b.astro", `---\nimport Other from "../layouts/Other.astro";\n---\n<Other><h1>x</h1></Other>`);
    const by = scanProject(dir, cfg).findings.filter((f) => f.rule === "missing-title").map((f) => f.file);
    expect(by).toEqual(["src/pages/b.astro"]);
  });
});

describe("3. route snapshot diff for bash", () => {
  beforeEach(() => {
    execSync("git init -q", { cwd: dir });
    for (const p of ["app/page.tsx", "app/blog/page.tsx", "app/blog/a/page.tsx", "app/about/page.tsx"]) put(p, "export default ()=>null");
    execSync("git add -A", { cwd: dir });
  });
  const cmds: [string, string][] = [
    ["glob", "rm -rf app/blog/*"], ["find -delete", "find app/blog -name 'page.tsx' -delete"], ["git rm -rf", "git rm -rqf app/blog"],
    ["rimraf-equivalent (npx unavailable offline)", "rm -rf app/blog"],
    ["node script", `node -e "require('fs').rmSync('app/blog',{recursive:true})"`],
    ["python", `python3 -c "import shutil; shutil.rmtree('app/blog')"`],
  ];
  for (const [name, cmd] of cmds) it(`${name}: ${cmd}`, () => {
    const before = snapshotRoutes(dir, cfg);
    execSync(cmd, { cwd: dir, shell: "/bin/bash", stdio: "ignore" });
    const f = snapshotRemovalFindings(dir, before, cfg);
    expect(f.map((x) => x.rule).every((x) => x === "route-removed")).toBe(true);
    expect(f.map((x) => x.message).join()).toMatch(/\/blog/);
  });
  it("redirect covers → silent; unrelated bash → silent", () => {
    put("vercel.json", JSON.stringify({ redirects: [{ source: "/about", destination: "/" }] }));
    const before = snapshotRoutes(dir, cfg);
    execSync("rm -rf app/about", { cwd: dir });
    expect(snapshotRemovalFindings(dir, before, cfg)).toEqual([]);
    const b2 = snapshotRoutes(dir, cfg);
    execSync("touch x.txt", { cwd: dir });
    expect(snapshotRemovalFindings(dir, b2, cfg)).toEqual([]);
  });
  it("homepage removed via script → critical after-the-fact, 'restore'", () => {
    const before = snapshotRoutes(dir, cfg);
    execSync("find app -maxdepth 1 -name 'page.tsx' -delete", { cwd: dir });
    const f = snapshotRemovalFindings(dir, before, cfg);
    expect(f[0]).toMatchObject({ rule: "homepage-removed", severity: "critical" });
    expect(f[0].message).toMatch(/RESTORE/);
  });
  it("extension: tool_call snapshot + tool_result diff", async () => {
    const handlers: Record<string, Function> = {};
    seoGuard({ on: (e: string, h: Function) => (handlers[e] = h), registerCommand: () => {}, sendMessage: () => {} } as any);
    const ctx = { cwd: dir, hasUI: false, ui: {} };
    expect(await handlers.tool_call({ toolName: "bash", toolCallId: "9", input: { command: "rm -rf app/blog/*" } }, ctx)).toBeUndefined();
    execSync("rm -rf app/blog/*", { cwd: dir, shell: "/bin/bash" });
    const res = await handlers.tool_result({ toolCallId: "9", toolName: "bash", isError: false, content: [{ type: "text", text: "" }] }, ctx);
    expect(res.content[1].text).toMatch(/route-removed.*\/blog/s);
  });
  it("snapshotRoutes:false disables", async () => {
    put(".pi/seo-guard.json", JSON.stringify({ snapshotRoutes: false }));
    const handlers: Record<string, Function> = {};
    seoGuard({ on: (e: string, h: Function) => (handlers[e] = h), registerCommand: () => {}, sendMessage: () => {} } as any);
    const ctx = { cwd: dir, hasUI: false, ui: {} };
    await handlers.tool_call({ toolName: "bash", toolCallId: "8", input: { command: "rm -rf app/blog/*" } }, ctx);
    execSync("rm -rf app/blog/*", { cwd: dir, shell: "/bin/bash" });
    expect(await handlers.tool_result({ toolCallId: "8", toolName: "bash", isError: false, content: [] }, ctx)).toBeUndefined();
  });
});

describe("4. hreflang / JSON-LD / image dimensions", () => {
  const head = (extra: string) => `<head><title>T</title>${extra}</head>`;
  const hl = `<link rel="alternate" hreflang="en" href="https://x.com/en"><link rel="alternate" hreflang="de" href="https://x.com/de">`;
  it("hreflang removed / changed", () => {
    expect(r("a.html", head(hl), head(hl.replace(/<link[^>]*de">/, "")))).toEqual(["warn:hreflang-changed"]);
    expect(r("a.html", head(hl), head(hl.replace("/de", "/german")))).toEqual(["warn:hreflang-changed"]);
    expect(r("a.html", head(hl), head(hl + `<link rel="alternate" hreflang="fr" href="/fr">`))).toEqual([]);
  });
  it("Next alternates.languages", () => {
    const b = `export const metadata = { title: "T", alternates: { canonical: "/", languages: { "en-US": "/en", de: "/de" } } };`;
    expect(r("app/page.tsx", b, b.replace(', de: "/de"', ""))).toEqual(["warn:hreflang-changed"]);
    expect(r("app/page.tsx", b, b.replace('"/en"', '"/en-us"'))).toEqual(["warn:hreflang-changed"]);
  });
  const ld = (j: string) => `<script type="application/ld+json">${j}</script>`;
  it("JSON-LD removed", () => expect(r("a.html", head(ld('{"@type":"Article"}')), head(""))).toEqual(["warn:jsonld-removed"]));
  it("JSON-LD made invalid", () => {
    expect(r("a.html", head(ld('{"@type":"Article"}')), head(ld('{"@type":"Article",}')))).toEqual(["warn:jsonld-invalid"]);
    expect(r("a.html", head(ld('{"@type":"Article"}')), head(ld('{"@type":"Article", "name": "b"}')))).toEqual([]);
  });
  it("JSON-LD in JSX with templated body is not judged", () => {
    const b = `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(j) }} />`;
    expect(r("src/P.tsx", b, b.replace("j)", "k)"))).toEqual([]);
    expect(r("src/P.tsx", b, `<p/>`)).toEqual(["warn:jsonld-removed"]);
  });
  it("Next jsonLd component removed", () => expect(r("src/P.tsx", `<><ProductJsonLd p={p}/></>`, `<></>`)).toEqual(["warn:jsonld-removed"]));
  it("img width/height lost", () => {
    expect(r("a.html", `<img src="a" alt="" width="1" height="1">`, `<img src="a" alt="">`)).toEqual(["warn:img-dimensions-removed"]);
    expect(r("src/P.tsx", `<Image src="/a.png" alt="" width={1} height={1}/>`, `<Image src="/a.png" alt=""/>`)).toEqual(["warn:img-dimensions-removed"]);
    expect(r("src/P.tsx", `<Image src="/a.png" alt="" width={1} height={1}/>`, `<Image src="/a.png" alt="" fill/>`)).toEqual([]);
    expect(r("src/P.tsx", `<img src="a" alt="" width="1" height="1"/>`, `<img src="a" alt="" className="aspect-video"/>`)).toEqual([]);
    expect(r("src/P.tsx", `<img src="a" alt="" width="1" height="1"/>`, `<img {...p} alt=""/>`)).toEqual([]);
  });
  it("configurable", () => {
    const off: SeoGuardConfig = { ignore: [], rules: { "hreflang-changed": "off", "jsonld-removed": "critical", "img-dimensions-removed": "off" } };
    expect(r("a.html", head(hl), head(""), off)).toEqual([]);
    expect(r("a.html", head(ld("{}")), head(""), off)).toEqual(["critical:jsonld-removed"]);
    expect(r("a.html", `<img width="1" height="1">`, `<img>`, off)).not.toContain("warn:img-dimensions-removed");
  });
});

describe("5. real-world tuning regressions", () => {
  it("scan: canonical only expected when the project uses it; test dirs ignored; redirect-only pages skipped", () => {
    put("app/layout.tsx", `export const metadata = { title: "S", description: "d" };`);
    put("app/a/page.tsx", `export default () => <h1>x</h1>`);
    put("app/__tests__/b/page.tsx", `export default () => null`);
    expect(scanProject(dir, cfg).findings).toEqual([]);
    put("src/pages/go.astro", `<meta http-equiv="refresh" content="0;URL=/">`);
    expect(scanProject(dir, cfg).findings.filter((f) => f.file === "src/pages/go.astro")).toEqual([]);
  });
  it("scan: docs-only repo (no routes) reports no broken links", () => {
    put("docs/a.md", "# A\n[x](/nope)");
    expect(scanProject(dir, cfg).findings).toEqual([]);
  });
  it("static-asset redirect removal and headers() sources are not redirect-removed", () => {
    const b = `module.exports = { redirects: { '/a.png': { redirect: '/a.webp' } } }`;
    expect(r("nuxt.config.ts", b, `module.exports = {}`)).toEqual([]);
    const n = `async headers() { return [{ source: '/(.*)', headers: [] }] }, async redirects() { return [{ source: '/old', destination: '/new' }] }`;
    expect(r("next.config.js", n, n.replace(/async redirects[\s\S]*$/, "}"))).toEqual(["warn:redirect-removed"]);
    expect(r("next.config.js", n, n.replace(/async headers\(\)[^,]*\]\s*\},/, ""))).toEqual([]);
  });
  it("delegating wrapper component keeps title/description", () => {
    expect(r("app/head.tsx", `<><title>T</title></>`, `<MdxHead params={params} />`)).toEqual([]);
  });
  it("wildcard-heavy redirect source doesn't crash", () => {
    put("nuxt.config.ts", `routeRules: { '/docs/3.x/examples/**': { redirect: '/x' } }`);
    put("pages/a.vue", "<template><h1>x</h1></template>");
    expect(() => scanProject(dir, cfg)).not.toThrow();
  });
  it("monorepo: apps/web/app/page.tsx is a route", async () => {
    const { fileToRoute } = await import("../src/routes.ts");
    expect(fileToRoute("apps/web/app/blog/page.tsx")?.route).toBe("/blog");
    expect(fileToRoute("packages/ui/src/page.tsx")).toBeNull();
  });
  it("Nuxt pure <NuxtPage/> wrapper isn't missing a title", () => {
    put("pages/enterprise.vue", "<template>\n  <NuxtPage />\n</template>");
    expect(scanProject(dir, cfg).findings).toEqual([]);
  });
});
