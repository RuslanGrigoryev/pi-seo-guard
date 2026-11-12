/** Minimal glob -> RegExp (supports **, *, ?, {a,b}). Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        re += "(?:" + glob.slice(i + 1, end).split(",").map(escape).join("|") + ")";
        i = end;
      } else re += "\\{";
    } else re += escape(c);
  }
  return new RegExp("^" + re + "$");
}
function escape(s: string) { return s.replace(/[.+^${}()|[\]\\]/g, "\\$&"); }

export function matchesAny(globs: string[], path: string): boolean {
  return globs.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(path) || globToRegExp(g.replace(/\/$/, "") + "/**").test(path));
}
