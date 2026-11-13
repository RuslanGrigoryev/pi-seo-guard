# Real-world testing (v0.2)

Method: shallow-ish clones of 8 popular open-source sites (`git clone --filter=blob:none`, HEAD at 2026-11-12). For each:

1. **Scan** — `scanProject()` (what `/seo-guard` runs) over the working tree. Any finding that isn't a real issue is a *false positive* (FP).
2. **Replay** — `scripts/real-world.ts <repo> 100`: take the last 100 non-merge commits that modify SEO-relevant files (pages, layouts, redirect configs, sitemap, robots, markdown), and feed every file's before/after through `diffFile` + the session ledger, as if the agent had made that edit. These are real human commits, almost all benign, so each finding is an FP unless noted as a true positive (TP).

"Before" = the v0.2 feature set *before tuning* (commit `ba72911`; the new rules are already in, so this isolates tuning, not new-rule noise). It crashes on nuxt.com (`/docs/3.x/**` redirect source → invalid regex; also present in 0.1.1), so for that repo "before" uses a one-line regex-guard patch. "After" = v0.2.0.
Reproduce: `node scripts/real-world.ts /path/to/repo 100`.

| Repo | Framework | Files scanned (after) | Routes | Scan findings before → after | Replayed edits (files) | Replay findings before → after | Notes |
|---|---|---:|---:|---|---:|---|---|
| vercel/commerce | Next app | 78 | 5 | 5 → 0 | 345 | 1 → 1 (TP) | missing-canonical on every page: canonical is now only expected when most pages/layout use it. TP: `/password` redirect removed in `next.config.js`. |
| shadcn-ui/taxonomy | Next app | 188 | 14 | 14 → 0 | 419 | 2 → 0 | FPs: `head.tsx` replaced by a delegating `<MdxHead params/>` wrapper |
| leerob/leerob.io | Next app + mdx | 15 | 4 | 0 → 0 | 201 | 1 → 0 | FP: `headers()` `source:` entries were read as redirect sources |
| withastro/astro.build | Astro | 10 247 | 23 | 6 → 0 | 166 (41 commits) | 4 → 0 | FPs: YAML frontmatter re-indented (`seo:\n  title:`) looked like title removal; `<Image>`→`<img>` swap flagged alt; redirect-only pages |
| nuxt/nuxt.com | Nuxt | 1 438 | 32 | 82 (crash patched) → 0 | 442 | 1 → 0 | FPs: shorthand `useSeoMeta({ title })`, `definePageMeta` redirect pages, `<NuxtPage/>` wrappers, markdown content links, static-asset redirect removal |
| sveltejs/kit | SvelteKit (repo, docs) | 552 | 0 | 319 → 0 | 260 | 1 → 0 | Repo is a framework monorepo: no site routes. Test fixtures (`test/`) excluded; no routes → no broken-link check. |
| withastro/starlight | Astro/docs | 897 | 0 | 0 → 0 | 244 | 0 → 0 | Docs-only; exercised for crash safety |
| shadcn-ui/ui (apps/v4) | Next app monorepo | 5 668 | 19 | 779 → 5 | 1 067 | 0 → 0 | Monorepo `apps/*/app` now recognised as routes; MDX content-collection links no longer judged. 5 left: `/terms`, `/privacy`, `/forms`, `/login`×2 — plausibly real dead links / demo links (unverified). |

## Totals

| | Before | After |
|---|---:|---:|
| `/seo-guard` findings across 8 repos | 1 205 (incl. 82 on nuxt.com with the crash patched) | 5 (all plausible TPs) |
| Replay findings over 3 144 file edits | 10 | 1 (a genuine redirect removal) |
| **Replay FP rate (per file edit)** | 9/3144 = 0.29 % | **0/3144 = 0 %** |
| Replay FP rate (per commit with SEO files, ~640) | ~1.4 % | 0 % |

Caveat: 0 FPs on 3 144 edits is a good sign but not proof — the replay only contains edits humans made, and the tuning was done on the same repos (overfitting risk). The tuning changes are generic though (see below) and each has a unit test (`test/v02.test.ts`, "real-world tuning regressions").

## Tuning that came out of it

- `/seo-guard`: `missing-canonical` only when ≥50 % of pages or a layout declare canonicals; skip `noindex` pages, redirect-only pages (`http-equiv=refresh`, `navigateTo`, `redirect()`), pure `<NuxtPage/>` wrappers.
- `/seo-guard`: broken-link check needs a route table and skips markdown that isn't a route (content collections served by a catch-all/CMS).
- Routes: monorepo prefixes (`apps/x/`, `packages/x/`, `website/`, `docs/`…); optional catch-all `/docs/*` also matches `/docs`; globs like `/x/**` in redirects no longer crash the regex builder.
- Paths: `test/`, `__tests__/`, `fixtures/`, `e2e/`, `*.test.*`, `*.stories.*` ignored everywhere.
- Extraction: indented YAML frontmatter keys, shorthand properties (`{ title }`), `{/* comments */}` stripped, delegating wrapper components (`<MdxHead params/>`) assume title/description.
- Redirects: only `{source, destination}` pairs count for next.config; removal of static-asset redirects (`*.png`, …) isn't reported.
- Image dimensions: `fill`, static imports, Tailwind `aspect-*`/`size-*`/`w-*`+`h-*`, `style` heights, `{...spread}` count as sized.

## Mutation sanity check (true-positive side)

`scripts/mutate.ts <repo>` applies two mutations to every route page and checks `title-removed` fires:

- **literal** — delete the first literal title (`<title>`, `title:`, `title=`).
- **indirect** (added in 0.4, #15) — blank the initialiser of `const title = …` / `const seoTitle = …`, i.e. the title is lost *through a variable*.

Detected / mutated, before (v0.3.0 logic) → after (v0.4.0, indirection resolver):

| Repo | Literal before → after | Indirect before → after |
|---|---|---|
| vercel/commerce | 4/4 → 4/4 | – (no such pages) |
| shadcn-ui/taxonomy | 8/13 → 8/13 | – |
| shadcn-ui/ui | 8/12 → 8/12 | 0/7 → 3/7 |
| leerob/leerob.io | 0/3 → **3/3** | – |
| withastro/astro.build | 13/18 → 13/18 | 0/2 → 2/2 |
| nuxt/nuxt.com | 3/28 → **5/28** | 0/25 → **20/25** |

nuxt.com's baseline 3/28 is mostly the crude mutator (many pages have `title` in several places or take it from content data: `pageData.value.title`, which is deliberately "unknown"). Gains: leerob.io's `.mdx` pages keep the title in `export const metadata` (now read), and nuxt.com `useSeoMeta({ title })` shorthand/`title: seoTitle` now resolve through `const`s. The `useHead`/`useSeoMeta` region is also the call's own argument list now, so a neighbouring `defineOgImage({ title })` no longer masks a removed title. Remaining misses are unresolvable on purpose (`const title = data.value.title`, function calls, `props` from CMS data, templates mixing unresolved parts) — no finding rather than a false positive. These are still lower bounds, not a recall measurement.

Replay (v0.4.0 vs v0.3.0 on the same repos, last 100 commits touching SEO files; commerce 184 file edits, taxonomy 339, ui 5, leerob.io 41, astro.build 3, nuxt.com 148 = 720 file edits): identical findings — the one TP (`/password` redirect removed in commerce `next.config.js`) and **0 FPs**; `/seo-guard` scan findings unchanged (ui: 5, others 0). The clones here are depth-40, so the replay window is smaller than the v0.2 run (3 144 edits).
