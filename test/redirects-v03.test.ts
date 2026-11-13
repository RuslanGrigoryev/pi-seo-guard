import { describe, expect, it } from "vitest";
import { isRedirectConfig, redirectCovers, redirectSources } from "../src/routes.ts";

const S = (f: string, c: string) => redirectSources(f, c).sort();

describe("firebase.json", () => {
  const j = JSON.stringify({ hosting: { redirects: [
    { source: "/old", destination: "/new", type: 301 },
    { source: "/blog/**", destination: "/news", type: 302 },
    { source: "/a/{x,y}", destination: "/b", type: 301 },
    { regex: "^/legacy/(.+)$", destination: "/n/:1", type: 301 },
  ] } });
  it("parses", () => expect(S("firebase.json", j)).toEqual(["/a/x", "/a/y", "/blog/*", "/legacy/*", "/old"]));
  it("array hosting", () => expect(S("firebase.json", JSON.stringify({ hosting: [{ redirects: [{ source: "/z", destination: "/y" }] }] }))).toEqual(["/z"]));
  it("malformed / missing", () => { expect(S("firebase.json", "{nope")).toEqual([]); expect(S("firebase.json", "{}")).toEqual([]); });
  it("is config", () => expect(isRedirectConfig("firebase.json")).toBe(true));
});

describe("_redirects edge cases", () => {
  const c = `# comment\n\n/home / 301\n/blog/* /news/:splat 301\n/p/:id /q/:id 302!\n/shop/*  https://shop.example.com/:splat  200\nhttps://example.com/abs /x 301\n/q?utm=1 /y\n/old\t/new\r\n/news/:year/:month /archive/:year/:month 301\n`;
  const r = S("_redirects", c);
  it("parses splat/placeholder/status/comments/absolute/query/tabs", () => {
    expect(r).toEqual(["/abs", "/blog/*", "/home", "/news/:year/:month", "/old", "/p/:id", "/q", "/shop/*"]);
  });
  it("covers", () => { expect(redirectCovers(r, "/blog/post")).toBe(true); expect(redirectCovers(r, "/p/5")).toBe(true); });
});

describe("nginx", () => {
  const c = `server {\n  # rewrite ^/commented$ /x permanent;\n  rewrite ^/old$ /new permanent;\n  rewrite ^/docs/(.*)$ /help/$1 redirect;\n  rewrite ^/internal /x last;\n  location = /gone { return 301 /elsewhere; }\n  location /legacy/ { return 308 https://x.com$request_uri; }\n  location ~ ^/img/(\\d+)$ { return 302 /i/$1; }\n  location /api { proxy_pass http://x; }\n}`;
  it("parses", () => expect(S("site.nginx.conf", c)).toEqual(["/docs/*", "/gone", "/img/:p", "/legacy/*", "/old"]));
  it("is config", () => { expect(isRedirectConfig("nginx.conf")).toBe(true); expect(isRedirectConfig("etc/nginx/conf.d/site.conf")).toBe(true); });
});

describe(".htaccess", () => {
  const c = `# c\nRedirect 301 /old /new\nRedirect permanent /x/ http://e.com/\nRedirect /plain /to\nRedirectMatch 301 ^/blog/(.*)$ /news/$1\nRedirectMatch "^/cat/(\\d+)$" /c/$1\nRewriteRule ^legacy/page$ /new [R=301,L]\nRewriteRule ^foo$ /bar [L]\nRewriteRule ^/fwd/(.*)$ /t/$1 [R,L]\n`;
  it("parses", () => expect(S(".htaccess", c)).toEqual(["/blog/*", "/cat/:p", "/fwd/*", "/legacy/page", "/old/*", "/plain/*", "/x/*"]));
  it("covers bare path", () => expect(redirectCovers(S(".htaccess", c), "/old")).toBe(true));
  it("is config", () => expect(isRedirectConfig("public/.htaccess")).toBe(true));
});

describe("docusaurus", () => {
  const c = `module.exports = { plugins: [['@docusaurus/plugin-client-redirects', { redirects: [ { to: '/docs/new', from: '/docs/old' }, { to: '/b', from: ['/a1', "/a2"] } ], createRedirects(p) { return undefined } }]] };`;
  it("parses", () => expect(S("docusaurus.config.js", c)).toEqual(["/a1", "/a2", "/docs/old"]));
  it("ignores unrelated config", () => expect(S("docusaurus.config.js", "const x = { from: '/z' }")).toEqual([]));
});

describe("sveltekit hooks.server", () => {
  it("simple pathname checks", () => {
    const c = `export const handle = async ({ event, resolve }) => {\n if (event.url.pathname === '/old') {\n throw redirect(301, '/new');\n }\n return resolve(event); };`;
    expect(S("src/hooks.server.ts", c)).toEqual(["/old"]);
  });
  it("redirect map", () => {
    const c = `const redirects: Record<string,string> = {\n '/a': '/b',\n '/c': '/d'\n};\nexport const handle = () => {};`;
    expect(S("src/hooks.server.ts", c)).toEqual(["/a", "/c"]);
  });
  it("complex logic is skipped without crashing", () => expect(S("hooks.server.js", "export const handle = ({event,resolve}) => compute(event)")).toEqual([]));
});

describe("never crashes", () => {
  it("garbage input", () => {
    const junk = ["(((", "[[[", "^/(a|", "\\", "*".repeat(50), "/(?<n>x", "{{{", "/a/{b,c", "\u0000"];
    for (const f of ["firebase.json", ".htaccess", "nginx.conf", "_redirects", "docusaurus.config.ts", "hooks.server.ts", "vercel.json", "next.config.js"]) {
      for (const j of junk) {
        expect(() => redirectSources(f, `${j}\nRedirectMatch 301 ${j} /x\nRewriteRule ${j} /x [R=301]\nrewrite ${j} /x permanent;\nlocation ~ ${j} { return 301 /x; }\n/a/${j} /b`)).not.toThrow();
        expect(() => redirectCovers(redirectSources(f, j), "/a/:b")).not.toThrow();
      }
    }
    expect(() => redirectCovers(["/(", "/[a", "/**/**"], "/x/*")).not.toThrow();
  });
});
