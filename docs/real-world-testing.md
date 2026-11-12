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

`scripts/mutate.ts` deletes the first `title` of every page and checks `title-removed` fires: commerce 4/4, astro.build 13/18, taxonomy 8/13, ui 8/12, nuxt.com 3/28, leerob.io 0/3. This mutator is crude (it removes one of several `title:` occurrences or edits `const title = …` that feeds a variable, which legitimately leaves the title "present"), so these are **lower bounds**, not a recall measurement. Known blind spots: titles via variables/`seoTitle` indirection (counted as present on both sides), MDX files that put the title in an `export const metadata` inside `.mdx`.
