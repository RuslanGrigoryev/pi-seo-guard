import { describe, expect, it } from "vitest";
import { diffFile } from "../src/rules.ts";
import type { SeoGuardConfig } from "../src/config.ts";

const cfg: SeoGuardConfig = { ignore: [], rules: {} };
const rules = (rel: string, b: string | null, a: string, c = cfg) => diffFile(rel, b, a, c).map((f) => `${f.severity}:${f.rule}`);

const page = `<html><head><title>Hi</title><meta name="description" content="d"><link rel="canonical" href="https://x.com/"></head><body><h1>Hello</h1><img src="a.png" alt="a"></body></html>`;

describe("html", () => {
  it("clean edit → nothing", () => expect(rules("index.html", page, page.replace("Hello", "Yo"))).toEqual([]));
  it("title removed", () => expect(rules("a.html", page, page.replace("<title>Hi</title>", ""))).toContain("warn:title-removed"));
  it("title emptied", () => expect(rules("a.html", page, page.replace("Hi</title>", "</title>"))).toContain("warn:title-removed"));
  it("description removed", () => expect(rules("a.html", page, page.replace(/<meta name="description"[^>]*>/, ""))).toContain("warn:description-removed"));
  it("canonical removed", () => expect(rules("a.html", page, page.replace(/<link rel="canonical"[^>]*>/, ""))).toContain("warn:canonical-removed"));
  it("noindex added (page)", () => expect(rules("a.html", page, page.replace("</head>", '<meta name="robots" content="noindex, follow"></head>'))).toEqual(["warn:noindex-added"]));
  it("nofollow added", () => expect(rules("a.html", page, page.replace("</head>", '<meta name="robots" content="nofollow"></head>'))).toEqual(["warn:nofollow-added"]));
  it("h1 removed", () => expect(rules("a.html", page, page.replace("<h1>Hello</h1>", "<p>Hello</p>"))).toContain("warn:h1-removed"));
  it("img alt removed", () => expect(rules("a.html", page, page.replace(' alt="a"', ""))).toContain("warn:img-alt-removed"));
  it("src/app.html noindex = sitewide critical", () =>
    expect(rules("src/app.html", page, page.replace("</head>", '<meta name="robots" content="noindex"></head>'))).toContain("critical:sitewide-noindex"));
  it("rule can be turned off / re-severitied", () => {
    expect(rules("a.html", page, page.replace("<title>Hi</title>", ""), { ignore: [], rules: { "title-removed": "off" } })).toEqual([]);
    expect(rules("a.html", page, page.replace("<title>Hi</title>", ""), { ignore: [], rules: { "title-removed": "critical" } })).toEqual(["critical:title-removed"]);
  });
});

describe("jsx / astro / vue / svelte", () => {
  it("tsx: h1 + alt + title", () => {
    const b = `export default () => <><title>T</title><h1>Hi</h1><img src="x" alt="x" /></>`;
    const a = `export default () => <><h1 className="x">Hi</h1><img src="x" /></>`;
    expect(rules("src/Page.tsx", b, a)).toEqual(expect.arrayContaining(["warn:title-removed", "warn:img-alt-removed"]));
    expect(rules("src/Page.tsx", b, `export default () => <><title>T</title><div/></>`)).toContain("warn:h1-removed");
  });
  it("tsx: spread props on img are not flagged", () =>
    expect(rules("a.tsx", `<img alt="x" src="a"/>`, `<img {...p} src="a"/>`)).toEqual([]));
  it("astro: frontmatter ignored, head parsed", () => {
    const b = `---\nconst t = "<h1>";\n---\n<head><title>T</title></head><h1>x</h1>`;
    expect(rules("src/pages/a.astro", b, b.replace("<title>T</title>", ""))).toEqual(["warn:title-removed"]);
  });
  it("vue", () => expect(rules("a.vue", `<template><h1>a</h1></template>`, `<template><h2>a</h2></template>`)).toEqual(["warn:h1-removed"]));
  it("svelte svelte:head", () => {
    const b = `<svelte:head><title>T</title></svelte:head><h1>a</h1>`;
    expect(rules("src/routes/+page.svelte", b, `<h1>a</h1>`)).toEqual(["warn:title-removed"]);
  });
});

describe("markdown / mdx frontmatter", () => {
  const md = `---\ntitle: "Post"\ndescription: Hello\n---\n# Heading\n\n![pic](a.png)\n`;
  it("title + description removed", () =>
    expect(rules("a.md", md, md.replace(/title:.*\n/, "").replace(/description:.*\n/, ""))).toEqual(["warn:title-removed", "warn:description-removed"]));
  it("title emptied", () => expect(rules("a.mdx", md, md.replace('"Post"', '""'))).toEqual(["warn:title-removed"]));
  it("h1 removed", () => expect(rules("a.md", md, md.replace("# Heading", "## Heading"))).toEqual(["warn:h1-removed"]));
  it("md image alt removed", () => expect(rules("a.md", md, md.replace("![pic]", "![]"))).toEqual(["warn:img-alt-removed"]));
  it("noindex in frontmatter", () => expect(rules("a.md", md, md.replace("---\n#", "noindex: true\n---\n#"))).toEqual(["warn:noindex-added"]));
});

describe("next metadata", () => {
  const b = `export const metadata = { title: 'Home', description: 'Desc', alternates: { canonical: 'https://x.com' } };\nexport default function P(){return <h1>x</h1>}`;
  it("title/description/canonical removed", () => {
    const a = `export const metadata = { };\nexport default function P(){return <h1>x</h1>}`;
    expect(rules("app/page.tsx", b, a)).toEqual(["warn:title-removed", "warn:description-removed", "warn:canonical-removed"]);
  });
  it("title emptied", () => expect(rules("app/page.tsx", b, b.replace("'Home'", "''"))).toEqual(["warn:title-removed"]));
  it("robots noindex added in page", () =>
    expect(rules("app/about/page.tsx", b, b.replace("title: 'Home'", "title: 'Home', robots: { index: false }"))).toEqual(["warn:noindex-added"]));
  it("robots noindex in root layout is CRITICAL", () => {
    const l = `export const metadata = { title: 'x' };`;
    expect(rules("app/layout.tsx", l, `export const metadata = { title: 'x', robots: 'noindex, nofollow' };`)).toEqual(["critical:sitewide-noindex", "warn:nofollow-added"]);
  });
});

describe("robots.txt", () => {
  it("Disallow: / for * is critical", () => expect(rules("public/robots.txt", "User-agent: *\nAllow: /\n", "User-agent: *\nDisallow: /\n")).toEqual(["critical:robots-disallow-all"]));
  it("Disallow: /admin is fine", () => expect(rules("robots.txt", null, "User-agent: *\nDisallow: /admin\n")).toEqual([]));
  it("other bot blocked is fine", () => expect(rules("robots.txt", null, "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n")).toEqual([]));
  it("grouped user-agents incl *", () => expect(rules("robots.txt", null, "User-agent: Bingbot\nUser-agent: *\nDisallow: /\n")).toEqual(["critical:robots-disallow-all"]));
  it("already blocking → not re-flagged", () => expect(rules("robots.txt", "User-agent: *\nDisallow: /\n", "User-agent: *\nDisallow: /\n# c\n")).toEqual([]));
});

describe("sitemap + redirect configs", () => {
  it("sitemap URLs removed", () =>
    expect(rules("public/sitemap.xml", `<urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>`, `<urlset><url><loc>https://x.com/a</loc></url></urlset>`)).toEqual(["warn:sitemap-urls-removed"]));
  it("vercel.json redirect removed", () => {
    const b = JSON.stringify({ redirects: [{ source: "/old", destination: "/new", permanent: true }] });
    expect(rules("vercel.json", b, "{}")).toEqual(["warn:redirect-removed"]);
  });
  it("_redirects removed", () => expect(rules("_redirects", "/old /new 301\n/a /b\n", "/a /b\n")).toEqual(["warn:redirect-removed"]));
  it("netlify.toml removed", () =>
    expect(rules("netlify.toml", `[[redirects]]\n from = "/old"\n to = "/new"\n`, ``)).toEqual(["warn:redirect-removed"]));
  it("next.config redirect removed", () =>
    expect(rules("next.config.js", `module.exports={async redirects(){return [{source:'/old',destination:'/new',permanent:true}]}}`, `module.exports={}`)).toEqual(["warn:redirect-removed"]));
  it("X-Robots-Tag noindex header added", () =>
    expect(rules("vercel.json", `{}`, `{"headers":[{"source":"/(.*)","headers":[{"key":"X-Robots-Tag","value":"noindex"}]}]}`)).toEqual(["critical:sitewide-noindex"]));
});
