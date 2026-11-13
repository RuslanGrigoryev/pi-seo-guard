import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diffFile } from "../src/rules.ts";
import { checkWrite } from "../src/guard.ts";
import { diskReader } from "../src/resolve.ts";
import type { SeoGuardConfig } from "../src/config.ts";

const cfg: SeoGuardConfig = { ignore: [], rules: {} };
let dir: string;
const put = (rel: string, c: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), c); };
const rules = (rel: string, b: string | null, a: string) => diffFile(rel, b, a, cfg, { after: diskReader(dir) }).map((f) => f.rule);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seo-ind-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("same-file indirection", () => {
  it("const title emptied in metadata", () => {
    const b = `const title = "Home"\nexport const metadata = { title }\n`;
    expect(rules("app/page.tsx", b, `const title = ""\nexport const metadata = { title }\n`)).toContain("title-removed");
  });
  it("const title with property form", () => {
    const b = `const t = "Home"\nexport const metadata = { title: t, description: "d" }\n`;
    expect(rules("app/page.tsx", b, `const t = ""\nexport const metadata = { title: t, description: "d" }\n`)).toContain("title-removed");
    expect(rules("app/page.tsx", b, `const t = "Other"\nexport const metadata = { title: t, description: "d" }\n`)).toEqual([]);
  });
  it("object property siteConfig.title", () => {
    const mk = (t: string) => `const siteConfig = { title: ${t}, d: 1 }\nexport const metadata = { title: siteConfig.title }\n`;
    expect(rules("app/page.tsx", mk('"Hi"'), mk('""'))).toContain("title-removed");
    expect(rules("app/page.tsx", mk('"Hi"'), mk("undefined"))).toContain("title-removed");
    expect(rules("app/page.tsx", mk('"Hi"'), mk('"Yo"'))).toEqual([]);
  });
  it("missing object property -> removed", () => {
    const b = `const c = { title: "x" }\nexport const metadata = { title: c.title }\n`;
    expect(rules("app/page.tsx", b, `const c = { name: "x" }\nexport const metadata = { title: c.title }\n`)).toContain("title-removed");
  });
  it("|| fallback keeps title present", () => {
    const a = `const t = ""\nexport const metadata = { title: t || "Fallback" }\n`;
    expect(rules("app/page.tsx", `export const metadata = { title: "A" }`, a)).toEqual([]);
  });
  it("unresolvable expressions stay unknown (no finding)", () => {
    const b = `export const metadata = { title: getTitle() }\n`;
    expect(rules("app/page.tsx", b, `export const metadata = { title: compute(x) }\n`)).toEqual([]);
    const c = `let t = "A"\nt = ""\nexport const metadata = { title: t }\n`;
    expect(rules("app/page.tsx", `export const metadata = { title: "A" }`, c)).toEqual([]);
    const d = `export const metadata = { title: data.title }\n`;
    expect(rules("app/page.tsx", d, d)).toEqual([]);
  });
  it("template literal with unresolved parts stays present", () => {
    const a = "export const metadata = { title: `${post.title} | Site` }\n";
    expect(rules("app/page.tsx", `export const metadata = { title: "A" }`, a)).toEqual([]);
  });
  it("vue useSeoMeta shorthand with const", () => {
    const mk = (t: string) => `<script setup>\nconst title = ${t}\nuseSeoMeta({ title })\n</script>\n<template><div/></template>`;
    expect(rules("pages/a.vue", mk("'Hi'"), mk("''"))).toContain("title-removed");
  });
  it("<title>{title}</title> in jsx", () => {
    const mk = (t: string) => `const title = ${t};\nexport default () => <head><title>{title}</title></head>`;
    expect(rules("pages/a.tsx", mk('"X"'), mk('""'))).toContain("title-removed");
  });
  it("SEO component prop title={title}", () => {
    const mk = (t: string) => `import { NextSeo } from "next-seo";\nconst title = ${t};\nexport default () => <NextSeo title={title} description="d" />`;
    expect(rules("pages/a.tsx", mk('"X"'), mk('""'))).toContain("title-removed");
    expect(rules("pages/a.tsx", mk('"X"'), mk('"Y"'))).toEqual([]);
  });
  it("astro Layout title={title}", () => {
    const mk = (t: string) => `---\nimport Layout from "../layouts/Layout.astro";\nconst title = ${t};\n---\n<Layout title={title}><h1>x</h1></Layout>`;
    expect(rules("src/pages/a.astro", mk("'X'"), mk("''"))).toContain("title-removed");
  });
});

describe("imported constants (one hop)", () => {
  const page = `import { siteConfig } from "@/config/site"\nexport const metadata = { title: siteConfig.title, description: siteConfig.description }\n`;
  it("relative import", () => {
    put("config/site.ts", `export const siteConfig = { title: "Hi", description: "d" }`);
    const p = `import { siteConfig } from "../config/site"\nexport const metadata = { title: siteConfig.title }\n`;
    expect(rules("app/page.tsx", p, p)).toEqual([]);
    put("config/site.ts", `export const siteConfig = { title: "", description: "d" }`);
    expect(diffFile("app/page.tsx", p.replace("siteConfig.title", '"Hi"'), p, cfg, { after: diskReader(dir) }).map((f) => f.rule)).toContain("title-removed");
  });
  it("tsconfig paths alias @/", () => {
    put("tsconfig.json", `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, }, }`);
    put("src/config/site.ts", `export const siteConfig = { title: "", description: "d" }`);
    // before (HEAD) had title, current file now resolves to empty
    const before = { read: (r: string) => (r === "src/config/site.ts" ? `export const siteConfig = { title: "Hi", description: "d" }` : diskReader(dir).read(r)), exists: () => true };
    const f = diffFile("app/page.tsx", page, page, cfg, { before, after: diskReader(dir) });
    expect(f.map((x) => x.rule)).toContain("title-removed");
  });
  it("custom alias without src/ convention", () => {
    put("tsconfig.json", `{ "compilerOptions": { "paths": { "~site/*": ["./lib/site/*"] } } }`);
    put("lib/site/cfg.ts", `export const cfg = { title: "" }`);
    const p = `import { cfg } from "~site/cfg"\nexport const metadata = { title: cfg.title }\n`;
    const before = { read: (r: string) => (r === "lib/site/cfg.ts" ? `export const cfg = { title: "T" }` : null), exists: () => true };
    expect(diffFile("app/page.tsx", p, p, cfg, { before, after: diskReader(dir) }).map((x) => x.rule)).toContain("title-removed");
  });
  it("edit to the imported config file itself is checked via the config's importers? (no: only direct file diffs)", () => {
    put("config/site.ts", `export const siteConfig = { title: "Hi" }`);
    expect(diffFile("config/site.ts", `export const siteConfig = { title: "Hi" }`, `export const siteConfig = { title: "" }`, cfg)).toEqual([]);
  });
  it("unresolvable import stays unknown", () => {
    const p = `import { siteConfig } from "some-package"\nexport const metadata = { title: siteConfig.title }\n`;
    expect(rules("app/page.tsx", `export const metadata = { title: "A" }`, p)).toEqual([]);
  });
  it("default export object and namespace import", () => {
    put("data/site.js", `export default { title: "" }`);
    put("data/ns.ts", `export const title = ""`);
    const p1 = `import site from "../data/site.js"\nexport const metadata = { title: site.title }\n`;
    const p2 = `import * as ns from "../data/ns"\nexport const metadata = { title: ns.title }\n`;
    expect(rules("app/page.tsx", `export const metadata = { title: "A" }`, p1)).toContain("title-removed");
    expect(rules("app/page.tsx", `export const metadata = { title: "A" }`, p2)).toContain("title-removed");
  });
  it("spread objects stay unknown", () => {
    put("config/site.ts", `import base from "./base"\nexport const siteConfig = { ...base }`);
    const p = `import { siteConfig } from "../config/site"\nexport const metadata = { title: siteConfig.title }\n`;
    expect(rules("app/page.tsx", `export const metadata = { title: "A" }`, p)).toEqual([]);
  });
  it("checkWrite uses disk for imports", () => {
    put("config/site.ts", `export const siteConfig = { title: "", description: "d" }`);
    put("app/page.tsx", `import { siteConfig } from "../config/site"\nexport const metadata = { title: "T" }\n`);
    const r = checkWrite(dir, "write", { path: "app/page.tsx", content: `import { siteConfig } from "../config/site"\nexport const metadata = { title: siteConfig.title }\n` }, cfg);
    expect(r.map((f) => f.rule)).toContain("title-removed");
  });
});

describe("wrapper components (one level)", () => {
  it("wrapper forwards title to <title>", () => {
    put("components/Shell.tsx", `export function Shell({ title, children }) { return <html><head><title>{title}</title></head><body>{children}</body></html> }`);
    const mk = (t: string) => `import { Shell } from "../components/Shell"\nexport default () => <Shell ${t}><h1>x</h1></Shell>`;
    expect(rules("pages/a.tsx", mk('title="Hi"'), mk(""))).toContain("title-removed");
    expect(rules("pages/a.tsx", mk('title="Hi"'), mk('title=""'))).toContain("title-removed");
    expect(rules("pages/a.tsx", mk('title="Hi"'), mk('title="Yo"'))).toEqual([]);
  });
  it("wrapper forwards to <SEO title={props.title}>", () => {
    put("components/Page.tsx", `export default function Page(props) { return <><SEO title={props.title} description={props.description} />{props.children}</> }`);
    const mk = (a: string) => `import Page from "../components/Page"\nexport default () => <Page ${a}>x</Page>`;
    expect(rules("pages/a.tsx", mk('title="A" description="d"'), mk('description="d"'))).toContain("title-removed");
  });
  it("wrapper default value keeps title present", () => {
    put("components/Shell.tsx", `export function Shell({ title = "Default" }) { return <head><title>{title}</title></head> }`);
    const mk = (t: string) => `import { Shell } from "../components/Shell"\nexport default () => <Shell ${t} />`;
    expect(rules("pages/a.tsx", mk('title="Hi"'), mk(""))).toEqual([]);
  });
  it("wrapper with spread props stays unknown", () => {
    put("components/Shell.tsx", `export function Shell({ title }) { return <head><title>{title}</title></head> }`);
    const mk = (t: string) => `import { Shell } from "../components/Shell"\nexport default (p) => <Shell ${t} {...p} />`;
    expect(rules("pages/a.tsx", mk('title="Hi"'), mk(""))).toEqual([]);
  });
  it("astro wrapper using Astro.props", () => {
    put("src/components/Shell.astro", `---\nconst { title } = Astro.props;\n---\n<html><head><title>{title}</title></head><body><slot/></body></html>`);
    const mk = (a: string) => `---\nimport Shell from "../components/Shell.astro";\n---\n<Shell ${a}><h1>x</h1></Shell>`;
    expect(rules("src/pages/a.astro", mk('title="Hi"'), mk(""))).toContain("title-removed");
  });
  it("vue wrapper with :title binding to a const", () => {
    put("components/Shell.vue", `<script setup>\nconst props = defineProps(['title'])\nuseSeoMeta({ title: props.title })\n</script>\n<template><slot/></template>`);
    const mk = (a: string) => `<script setup>\nimport Shell from "../components/Shell.vue"\nconst t = ${a}\n</script>\n<template><Shell :title="t"/></template>`;
    expect(rules("pages/a.vue", mk("'Hi'"), mk("''"))).toContain("title-removed");
  });
  it("wrapper that doesn't render SEO tags is ignored", () => {
    put("components/Box.tsx", `export const Box = ({ title }) => <div>{title}</div>`);
    const mk = (t: string) => `import { Box } from "../components/Box"\nexport default () => <Box ${t} />`;
    expect(rules("pages/a.tsx", mk('title="Hi"'), mk(""))).toEqual([]);
  });
});
