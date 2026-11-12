import { type Facts, extractFacts } from "./extract.ts";
import type { Finding } from "./rules.ts";
import { type Exists, ancestorsOf, makeReader } from "./inherit.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type Key = "title" | "description" | "canonical" | "jsonld";
const RULE_KEY: Record<string, Key> = {
  "title-removed": "title", "description-removed": "description", "canonical-removed": "canonical", "jsonld-removed": "jsonld",
};
const has = (f: Facts, k: Key) => (k === "jsonld" ? f.jsonLd > 0 : f[k] === "present");

interface Entry { facts: Facts; content: string }
interface Unresolved { rule: string; file: string; key: Key; content: string }

/**
 * Per-session ledger of SEO facts across edited files. A "title/description/canonical/jsonld removed"
 * finding is suppressed when an ancestor layout/parent (or, vice versa, a descendant page) edited in the
 * same session carries an equivalent fact — i.e. the fact was moved, not lost.
 */
export class SeoLedger {
  private files = new Map<string, Entry>();
  private unresolved: Unresolved[] = [];
  private notes: string[] = [];

  reset() { this.files.clear(); this.unresolved = []; this.notes = []; }
  drainNotes(): string[] { const n = this.notes; this.notes = []; return n; }

  private exists(cwd: string): Exists { return (r) => this.files.has(r) || existsSync(resolve(cwd, r)); }
  private read(cwd: string) {
    const disk = makeReader(cwd);
    return (r: string) => this.files.get(r)?.content ?? disk(r);
  }

  /** Are `a` and `b` in an ancestor/descendant relationship (either direction)? */
  related(cwd: string, a: string, aContent: string, b: string, bContent: string): boolean {
    const ex = this.exists(cwd), rd = this.read(cwd);
    return ancestorsOf(a, aContent, ex, rd).includes(b) || ancestorsOf(b, bContent, ex, rd).includes(a);
  }

  /** Record an edit (file now has `after` content) and filter its findings. */
  observe(cwd: string, file: string, content: string, findings: Finding[]): Finding[] {
    const facts = extractFacts(file, content);
    if (facts) this.files.set(file, { facts, content });
    else return findings;

    // 1. a fact appeared here → resolve earlier unsuppressed removals in related files
    for (const k of ["title", "description", "canonical", "jsonld"] as Key[]) {
      if (!has(facts, k)) continue;
      this.unresolved = this.unresolved.filter((u) => {
        if (u.key !== k || u.file === file || !this.related(cwd, file, content, u.file, u.content)) return true;
        this.notes.push(`pi-seo-guard: earlier \`${u.rule}\` for ${u.file} is resolved — equivalent ${k} now lives in ${file}.`);
        return false;
      });
    }
    // 2. suppress removals that were moved to/from a related file edited this session
    const kept: Finding[] = [];
    for (const f of findings) {
      const key = RULE_KEY[f.rule];
      if (!key || f.file !== file) { kept.push(f); continue; }
      let moved = false;
      for (const [other, e] of this.files) {
        if (other === file || !has(e.facts, key)) continue;
        if (this.related(cwd, file, content, other, e.content)) { moved = true; break; }
      }
      if (moved) continue;
      kept.push(f);
      this.unresolved.push({ rule: f.rule, file, key, content });
    }
    return kept;
  }
}
