# pi-seo-guard

A [Pi](https://pi.dev) extension that stops the coding agent from silently wrecking your SEO. It diffs every `edit`/`write` of SEO-relevant files **before** it lands, blocks catastrophic changes, and feeds smaller regressions back to the agent so it fixes them in the same turn. Fully offline — no network, no API keys.

## Demo

![pi-seo-guard demo](https://raw.githubusercontent.com/RuslanGrigoryev/pi-seo-guard/main/docs/demo.gif)

## Install

```bash
pi install npm:pi-seo-guard
# or try without installing:
pi -e npm:pi-seo-guard
```

## What it does

| Severity | Behaviour |
|---|---|
| **CRITICAL** | The tool call is **blocked** and Pi asks you to confirm (`ctx.ui.confirm`). Declining stops the agent. In headless modes (`-p`, `--mode json`) there is nobody to ask, so it **fails closed** with an explanatory message. |
| **WARN** | The edit goes through; a concise finding is appended to the tool result so the agent fixes it right away. |

## Rules

| Rule id | Default | Detects |
|---|---|---|
| `sitewide-noindex` | critical | `noindex` added to a root layout / `app.html` / `_document`, or an `X-Robots-Tag: noindex` header added in vercel.json / netlify.toml / next.config |
| `robots-disallow-all` | critical | `robots.txt` where `User-agent: *` has `Disallow: /` (and no `Allow: /`) |
| `homepage-removed` | critical | `rm` / `mv` / `git rm` / `git mv` of the homepage route file (via the `bash` tool) |
| `unverifiable-critical-write` | critical | a `bash` command writes to `robots.txt` or the root layout in a way the guard can't simulate (see below) |
| `title-removed` | warn | `<title>`, Next `metadata.title`, Nuxt `useHead`, or frontmatter `title` removed or emptied |
| `description-removed` | warn | meta description removed or emptied |
| `canonical-removed` | warn | canonical link / `alternates.canonical` removed |
| `noindex-added` | warn | `noindex` added to a single page (meta, Next `robots`, frontmatter) |
| `nofollow-added` | warn | `nofollow` added to robots meta |
| `h1-removed` | warn | file had an `<h1>` / `# Heading` and now has none |
| `img-alt-removed` | warn | more `<img>` / `![]()` without alt than before |
| `route-removed` | warn | route file deleted/renamed (Next app+pages, Astro, SvelteKit, Nuxt) with no matching redirect |
| `redirect-removed` | warn | redirect rule removed from vercel.json, netlify.toml, `_redirects`, next/astro config |
| `sitemap-urls-removed` | warn | URLs dropped from `sitemap.xml` |
| `unverifiable-write` | warn | a `bash` command writes to another watched file (sitemap, redirects, page/layout) in a way the guard can't simulate |

`/seo-guard` additionally uses: `broken-link`, `sitemap-missing-route`, `missing-title`, `missing-description`, `missing-canonical` (all warn).

### Writes through `bash`

Since 0.1.1 the guard also looks at shell commands that modify watched SEO files: `sed -i` / `sed -i.bak` / `perl -pi -e` (simple `s///` is applied in JS), `>` / `>>` redirects of `echo` / `printf` / `cat` / heredocs, `tee [-a]`, `cp` / `mv` onto a watched file, `truncate`, and `bash -c '…'` wrappers. When the result can be computed it goes through the normal rules (e.g. `sed -i 's/Allow/Disallow/' robots.txt` → `robots-disallow-all`). When it can't (complex sed, `$VAR`, command output, scripts), a write to `robots.txt` or the root layout asks for confirmation (headless: blocked), and other watched files get a WARN. Reads (`cat`, `grep`, `sed -n`, `sed` without `-i`) and writes to unwatched paths never trigger.

## `/seo-guard`

Scans the project (offline) and reports:

- broken internal links (`<a href>`, `<Link>`, markdown links) that match no route, static file or redirect
- routes missing from `sitemap.xml`
- routes present in git `HEAD` but gone now, with no redirect
- pages missing title / description / canonical (layout-provided values count)

The report is shown in the UI and queued as a hidden message for the agent's next turn.

## Config — `.pi/seo-guard.json`

```json
{
  "baseUrl": "https://example.com",
  "ignore": ["legacy/**", "**/*.stories.tsx", "public/vendor/**"],
  "rules": {
    "h1-removed": "off",
    "title-removed": "critical",
    "noindex-added": "warn"
  }
}
```

- `ignore` — globs (`*`, `**`, `?`, `{a,b}`) relative to project root. `node_modules`, `.git`, build dirs are always skipped.
- `rules` — per rule: `"critical"`, `"warn"` or `"off"`.
- `baseUrl` — absolute links/sitemap `<loc>` under this URL are treated as internal.

Invalid JSON falls back to defaults with a warning.

## Limits (v1)

- **Parsing is lenient, not semantic.** HTML/Astro/Vue/Svelte/JSX go through [htmlparser2](https://github.com/fb55/htmlparser2); Next/Nuxt metadata and frontmatter use **regex** on literal values. Computed titles (`title: getTitle()`) count as "present"; dynamic `generateMetadata` bodies are only skimmed.
- Components that set `<title>` indirectly (`<SEO title=… />`) are not understood; a component `<Image>` without `alt` is flagged but `{...props}` spreads are assumed to supply it.
- Checks are **per file**: moving a `<title>` from a page into a layout in the same turn looks like removal (a WARN).
- Route deletion is detected for **bash** `rm`/`mv`/`git rm`/`git mv` with literal paths — not globs, `$(…)`, scripts, or `find -delete`.
- Redirect parsing for `next.config.*`/`astro.config.*` is regex-based on `source:` / path keys.
- Sitemaps generated at build time (`next-sitemap`, `@astrojs/sitemap`) can't be checked; `/seo-guard` says so.
- Bash write detection is best-effort shell parsing: no variable expansion, globs, `$(…)`, or scripts run via `python`/`node` that write files themselves (those are only caught if they redirect into a watched file). `sed`/`perl` support covers plain `s///` substitutions.
- Only checks what the agent does through Pi's `edit`, `write`, `bash` tools; it is not a build-time linter.

## Development

```bash
npm install
npm test
npm run tsc
pi -e .      # load locally
```

## License

MIT
