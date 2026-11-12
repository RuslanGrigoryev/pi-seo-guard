import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashWriteFindings, parseCommand } from "../src/bashwrite.ts";

let dir: string;
const put = (p: string, c: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
const cfg = { ignore: [], rules: {} };
const run = (cmd: string) => bashWriteFindings(dir, cmd, cfg).map((f) => `${f.severity}:${f.rule}:${f.file}`);
const ROBOTS = "User-agent: *\nAllow: /\n";
const LAYOUT = `export const metadata = {\n  title: "T",\n  description: "D",\n};\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seobash-"));
  put("public/robots.txt", ROBOTS);
  put("public/sitemap.xml", `<urlset><url><loc>https://x.com/</loc></url><url><loc>https://x.com/a</loc></url></urlset>`);
  put("app/layout.tsx", LAYOUT);
  put("app/page.tsx", "export default ()=>null");
  put("vercel.json", `{"redirects":[{"source":"/old","destination":"/new"}]}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("bash writes: simulated", () => {
  it("sed -i flipping Allow to Disallow in robots.txt", () => {
    expect(run("sed -i 's/Allow: \\//Disallow: \\//' public/robots.txt")).toEqual(["critical:robots-disallow-all:public/robots.txt"]);
  });
  it("sed -i.bak / -i '' / -E / -e variants", () => {
    expect(run("sed -i.bak 's|Allow: /|Disallow: /|' public/robots.txt")).toHaveLength(1);
    expect(run("sed -i '' 's/Allow/Disallow/' public/robots.txt")).toHaveLength(1);
    expect(run("sed -E -i -e 's/(Allow)/Dis\\1/' public/robots.txt")).toHaveLength(1);
    expect(run("sed --in-place 's/Allow/Disallow/' public/robots.txt")).toHaveLength(1);
  });
  it("sed -i that is harmless", () => {
    expect(run("sed -i 's/User-agent/User-Agent/' public/robots.txt")).toEqual([]);
  });
  it("perl -pi -e", () => {
    expect(run("perl -pi -e 's/Allow: \\//Disallow: \\//' public/robots.txt")).toEqual(["critical:robots-disallow-all:public/robots.txt"]);
  });
  it("echo / printf redirect", () => {
    expect(run("echo 'User-agent: *\nDisallow: /' > public/robots.txt")).toHaveLength(1);
    expect(run('printf "User-agent: *\\nDisallow: /\\n" > public/robots.txt')[0]).toMatch(/^critical:robots-disallow-all/);
    expect(run("echo 'User-agent: *' > public/robots.txt && echo 'Disallow: /' >> public/robots.txt")).toHaveLength(1);
    expect(run("echo 'User-agent: *' > public/robots.txt")).toEqual([]);
    expect(run("echo 'Allow: /' >> public/robots.txt")).toEqual([]);
  });
  it("heredoc", () => {
    expect(run("cat > public/robots.txt <<'EOF'\nUser-agent: *\nDisallow: /\nEOF")).toEqual(["critical:robots-disallow-all:public/robots.txt"]);
    expect(run("cat <<EOF > public/robots.txt\nUser-agent: *\nDisallow:\nEOF")).toEqual([]);
  });
  it("tee / tee -a", () => {
    expect(run("printf 'User-agent: *\\nDisallow: /\\n' | tee public/robots.txt")).toHaveLength(1);
    put("public/robots.txt", "User-agent: *\n");
    expect(run("echo 'Disallow: /' | tee -a public/robots.txt")).toHaveLength(1);
    expect(run("echo 'x' | tee -a public/robots.txt")).toEqual([]);
  });
  it("cp / mv onto a watched file", () => {
    put("/tmp-stage/robots.txt", "User-agent: *\nDisallow: /\n");
    expect(run("cp stage.txt public/robots.txt")).toEqual([]); // nonexistent source: command fails
    put("stage.txt", "User-agent: *\nDisallow: /\n");
    expect(run("cp stage.txt public/robots.txt")).toEqual(["critical:robots-disallow-all:public/robots.txt"]);
    expect(run("mv -f stage.txt public/")).toEqual([]); // dest name stage.txt unwatched
    put("public/robots.txt.new", "x");
    expect(run("cp stage.txt public")).toEqual([]);
  });
  it("truncate -s 0 empties sitemap → URLs removed (warn)", () => {
    expect(run("truncate -s 0 public/sitemap.xml")).toEqual(["warn:sitemap-urls-removed:public/sitemap.xml"]);
  });
  it("sed -i removing the description from a page", () => {
    put("app/about/page.tsx", LAYOUT);
    expect(run(`sed -i '/description: "D",/d' app/about/page.tsx`)).toEqual(["warn:unverifiable-write:app/about/page.tsx"]);
    expect(run(`sed -i 's/description: "D",//' app/about/page.tsx`)).toEqual(["warn:description-removed:app/about/page.tsx"]);
  });
  it("adding noindex to the root layout via sed is critical", () => {
    expect(run(`sed -i 's/title: "T",/title: "T", robots: { index: false },/' app/layout.tsx`)).toEqual(["critical:sitewide-noindex:app/layout.tsx"]);
  });
  it("redirect config edit", () => {
    expect(run(`sed -i 's#"/old"#"/older"#' vercel.json`)).toEqual(["warn:redirect-removed:vercel.json"]);
  });
  it("bash -c wrapper and sudo", () => {
    expect(run(`bash -c "echo 'User-agent: *\nDisallow: /' > public/robots.txt"`)).toHaveLength(1);
    expect(run("sudo tee public/robots.txt <<< x")).toEqual(["critical:unverifiable-critical-write:public/robots.txt"]); // here-string content unknown
  });
});

describe("bash writes: unverifiable", () => {
  it("complex sed on robots.txt → critical unverifiable", () => {
    expect(run("sed -i '1,2d' public/robots.txt")).toEqual(["critical:unverifiable-critical-write:public/robots.txt"]);
    expect(run("sed -i 's/Allow/\\U&/' public/robots.txt")).toEqual(["critical:unverifiable-critical-write:public/robots.txt"]);
  });
  it("dynamic content into robots.txt or root layout → critical unverifiable", () => {
    expect(run("echo $CONTENT > public/robots.txt")).toEqual(["critical:unverifiable-critical-write:public/robots.txt"]);
    expect(run("curl -s https://x.com/r | tee public/robots.txt")).toEqual(["critical:unverifiable-critical-write:public/robots.txt"]);
    expect(run("python3 gen.py > app/layout.tsx")).toEqual(["critical:unverifiable-critical-write:app/layout.tsx"]);
  });
  it("other watched files → warn only", () => {
    expect(run("python3 gen.py > public/sitemap.xml")).toEqual(["warn:unverifiable-write:public/sitemap.xml"]);
    expect(run("sed -i '1d' app/page.tsx")).toEqual(["warn:unverifiable-write:app/page.tsx"]);
  });
  it("rule severity can be tuned", () => {
    const c = { ignore: [], rules: { "unverifiable-critical-write": "warn" as const } };
    expect(bashWriteFindings(dir, "echo $X > public/robots.txt", c)[0].severity).toBe("warn");
    const off = { ignore: [], rules: { "unverifiable-critical-write": "off" as const } };
    expect(bashWriteFindings(dir, "echo $X > public/robots.txt", off)).toEqual([]);
  });
});

describe("bash writes: must not trigger", () => {
  it.each([
    "cat public/robots.txt",
    "grep -n Disallow public/robots.txt",
    "sed -n '1,5p' public/robots.txt",
    "sed 's/Allow/Disallow/' public/robots.txt",
    "sed 's/Allow/Disallow/' public/robots.txt > /tmp/out.txt",
    "cat public/robots.txt > /tmp/copy.txt",
    "cp public/robots.txt /tmp/robots.bak",
    "cp public/robots.txt public/robots.txt.bak",
    "echo hi > notes.txt",
    "echo hi > app/notes.md.txt",
    "ls > /dev/null 2>&1",
    "npm test 2>&1 | tail -5",
    "cat public/robots.txt | head -3",
    "echo done >&2",
    "diff public/robots.txt other.txt",
    "mv notes.txt old-notes.txt",
    "tee /tmp/log < public/robots.txt",
    "head -n1 < public/robots.txt",
    "perl -ne 'print if /Allow/' public/robots.txt",
    "echo 'Disallow: /' > /tmp/robots.txt",
    "touch public/robots.txt",
    "find . -name robots.txt",
    "echo 'a > b' | wc -c",
    "git diff -- public/robots.txt",
  ])("%s", (cmd) => expect(run(cmd)).toEqual([]));
  it("ignored paths", () => {
    expect(bashWriteFindings(dir, "echo $X > public/robots.txt", { ignore: ["public/**"], rules: {} })).toEqual([]);
  });
});

describe("parseCommand", () => {
  it("splits statements, pipes, redirects, heredocs", () => {
    const p = parseCommand("a 1 | b 2 > out; c <<EOF >> f\nbody\nEOF\nd");
    expect(p.length).toBe(3);
    expect(p[0].length).toBe(2);
    expect(p[0][1].redirs[0].target?.text).toBe("out");
    expect(p[1][0].heredoc?.body).toBe("body\n");
    expect(p[1][0].redirs[0].op).toBe(">>");
  });
});
