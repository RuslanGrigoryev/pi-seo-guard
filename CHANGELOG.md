# Changelog

## 0.3.0
- **More redirect formats** (so removed routes covered by a redirect are not flagged): `firebase.json` `hosting.redirects` (`source` globs incl. `{a,b}`, `regex`), Cloudflare Pages / Netlify `_redirects` edge cases (splats, placeholders, status codes incl. `301!`, absolute-URL and query sources, comments, tabs), nginx (`rewrite … permanent|redirect;`, `location = /x { return 301 …; }`, prefix and `~` locations), Apache `.htaccess` (`Redirect`, `RedirectMatch`, `RewriteRule … [R=301]`), Docusaurus `@docusaurus/plugin-client-redirects` (`from`), and SvelteKit `hooks.server` (only simple `pathname === '/x'` + `redirect()` checks and literal redirect maps — complex logic is skipped).
- Redirect parsing and pattern compilation never throw on malformed input.
- CI (`ci.yml`) and tag-triggered npm trusted publishing with provenance (`release.yml`); see `RELEASING.md`.

## 0.2.0
- **SEO components/props**: `<NextSeo title description canonical noindex>`, generic `<SEO|Seo|Head|Meta title=…>`, Astro `<Layout title description>`, Nuxt `useHead`/`useSeoMeta` (incl. `meta: [{name:…}]`), SvelteKit `<svelte:head>`, Remix `meta`/`links` exports. Removal/emptying follows the literal-tag rules; a `noindex` prop is the new CRITICAL rule `component-noindex`.
- **Layout inheritance**: per-session ledger of SEO facts. A title/description/canonical/JSON-LD "removed" finding is suppressed when an ancestor layout/parent (Next app nesting, `_app`/`_document`, SvelteKit `+layout`, Nuxt layouts/app.vue, imported Astro/Vue/Svelte layouts) or a descendant page carries it in the same session — in either order. `/seo-guard` resolves ancestors before reporting `missing-title|description|canonical`.
- **Route deletion beyond literals**: the route list is snapshotted before/after every `bash` call and diffed (globs, `find -delete`, `git rm -r`, `rimraf`, node/python scripts…). Removed routes without redirect → WARN; homepage → after-the-fact CRITICAL message telling the agent to restore it. Disable with `"snapshotRoutes": false`.
- **New rules**: `hreflang-changed`, `jsonld-removed`, `jsonld-invalid`, `img-dimensions-removed` (all warn, configurable), `component-noindex` (critical).
- **Real-world tuning** against 8 OSS repos (see `docs/real-world-testing.md`): replay FP rate 0.29 % → 0 %, `/seo-guard` findings 1 205 → 5. Monorepo route detection, test/fixture paths ignored, canonical only expected where used, no crash on `**` redirect sources.

## 0.1.1
- Detect writes to SEO files made through the `bash` tool: `sed -i`, `perl -pi`, `>` / `>>` redirects (echo/printf/cat/heredoc), `tee [-a]`, `cp`/`mv` onto a watched file, `truncate`, `bash -c`. Results are simulated and run through the normal rules.
- New rules `unverifiable-critical-write` (critical; robots.txt / root layout) and `unverifiable-write` (warn) for bash writes that can't be simulated.
- README: demo GIF, limits update.

## 0.1.0
- Initial release: edit-time guard for `edit`/`write`/`bash rm|mv`, critical confirmation (fail-closed headless), warn feedback to the agent, `/seo-guard` scan, `.pi/seo-guard.json` config.
