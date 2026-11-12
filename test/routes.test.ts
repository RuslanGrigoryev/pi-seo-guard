import { describe, expect, it } from "vitest";
import { fileToRoute, redirectCovers, redirectSources } from "../src/routes.ts";
import { removedPathsFromBash } from "../src/guard.ts";

describe("fileToRoute", () => {
  const r = (p: string) => fileToRoute(p)?.route ?? null;
  it("next app", () => { expect(r("app/page.tsx")).toBe("/"); expect(r("src/app/blog/[slug]/page.tsx")).toBe("/blog/:slug"); expect(r("app/(marketing)/about/page.tsx")).toBe("/about"); expect(r("app/layout.tsx")).toBeNull(); });
  it("next pages", () => { expect(r("pages/index.tsx")).toBe("/"); expect(r("pages/a/index.js")).toBe("/a"); expect(r("pages/api/x.ts")).toBeNull(); expect(r("pages/_app.tsx")).toBeNull(); });
  it("astro", () => { expect(r("src/pages/index.astro")).toBe("/"); expect(r("src/pages/blog/[id].md")).toBe("/blog/:id"); });
  it("sveltekit", () => { expect(r("src/routes/+page.svelte")).toBe("/"); expect(r("src/routes/docs/[...rest]/+page.svelte")).toBe("/docs/*"); });
  it("nuxt", () => { expect(r("pages/index.vue")).toBe("/"); expect(r("pages/about.vue")).toBe("/about"); });
});
describe("redirects", () => {
  it("covers", () => {
    expect(redirectCovers(["/old"], "/old")).toBe(true);
    expect(redirectCovers(["/blog/*"], "/blog/:slug")).toBe(true);
    expect(redirectCovers(["/other"], "/old")).toBe(false);
  });
  it("sources", () => expect(redirectSources("_redirects", "# c\n/a /b 301\n")).toEqual(["/a"]));
});
describe("bash removal parsing", () => {
  it("rm / mv / git rm", () => {
    expect(removedPathsFromBash("rm -rf app/page.tsx && ls")).toEqual(["app/page.tsx"]);
    expect(removedPathsFromBash("git mv src/pages/a.astro src/pages/b.astro")).toEqual(["src/pages/a.astro"]);
    expect(removedPathsFromBash("mv 'a b.md' c.md")).toEqual(["a b.md"]);
    expect(removedPathsFromBash("cat x")).toEqual([]);
  });
});
