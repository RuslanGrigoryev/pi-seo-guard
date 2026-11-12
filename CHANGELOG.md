# Changelog

## 0.1.1
- Detect writes to SEO files made through the `bash` tool: `sed -i`, `perl -pi`, `>` / `>>` redirects (echo/printf/cat/heredoc), `tee [-a]`, `cp`/`mv` onto a watched file, `truncate`, `bash -c`. Results are simulated and run through the normal rules.
- New rules `unverifiable-critical-write` (critical; robots.txt / root layout) and `unverifiable-write` (warn) for bash writes that can't be simulated.
- README: demo GIF, limits update.

## 0.1.0
- Initial release: edit-time guard for `edit`/`write`/`bash rm|mv`, critical confirmation (fail-closed headless), warn feedback to the agent, `/seo-guard` scan, `.pi/seo-guard.json` config.
