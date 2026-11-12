import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { type Finding, formatFindings } from "./rules.ts";
import { checkWrite, criticalRemovalFindings, routeRemovalsFromBash, unredirectedRemovals, type PendingRouteRemoval } from "./guard.ts";
import { bashWriteFindings } from "./bashwrite.ts";
import { formatScan, scanProject } from "./scan.ts";

export default function seoGuard(pi: ExtensionAPI) {
  // Findings computed in `tool_call` (before execution), delivered in `tool_result` (after execution).
  const pendingWarn = new Map<string, Finding[]>();
  const pendingRemovals = new Map<string, PendingRouteRemoval[]>();

  pi.on("session_start", (_e, ctx) => {
    const { error } = loadConfig(ctx.cwd);
    if (error && ctx.hasUI) ctx.ui.notify(`pi-seo-guard: ${error}`, "warning");
  });

  pi.on("tool_call", async (event, ctx) => {
    const { config } = loadConfig(ctx.cwd);
    let findings: Finding[] = [];
    if (isToolCallEventType("edit", event)) findings = checkWrite(ctx.cwd, "edit", event.input, config);
    else if (isToolCallEventType("write", event)) findings = checkWrite(ctx.cwd, "write", event.input, config);
    else if (isToolCallEventType("bash", event)) {
      const removals = routeRemovalsFromBash(ctx.cwd, event.input.command ?? "", config);
      if (removals.length) pendingRemovals.set(event.toolCallId, removals);
      findings = [...criticalRemovalFindings(removals, config), ...bashWriteFindings(ctx.cwd, event.input.command ?? "", config)];
    } else return;

    const critical = findings.filter((f) => f.severity === "critical");
    const warns = findings.filter((f) => f.severity === "warn");
    if (warns.length) pendingWarn.set(event.toolCallId, warns);

    if (critical.length) {
      const detail = formatFindings(critical);
      if (!ctx.hasUI) {
        // Headless (print / json): no one to ask → fail closed.
        return { block: true, reason: `pi-seo-guard blocked this change (no UI available to confirm, failing closed):\n${detail}\nTo allow it, set the rule to "warn" or "off" in .pi/seo-guard.json, or ask the user to run Pi interactively.` };
      }
      const ok = await ctx.ui.confirm("SEO guard: critical change", `${detail}\n\nAllow this change?`);
      if (!ok) {
        pendingWarn.delete(event.toolCallId);
        pendingRemovals.delete(event.toolCallId);
        return { block: true, reason: `pi-seo-guard: the user declined a CRITICAL SEO change:\n${detail}\nDo not retry it. Stop and ask the user how to proceed.`, terminate: true };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const warns = pendingWarn.get(event.toolCallId) ?? [];
    const removals = pendingRemovals.get(event.toolCallId);
    pendingWarn.delete(event.toolCallId);
    pendingRemovals.delete(event.toolCallId);
    if (event.isError) return;
    const all = [...warns];
    if (removals) all.push(...unredirectedRemovals(ctx.cwd, removals, loadConfig(ctx.cwd).config));
    if (!all.length) return;
    const text = `\n\n⚠ pi-seo-guard found SEO regressions in this change. Fix them in this turn (or confirm they are intentional):\n${formatFindings(all)}`;
    return { content: [...event.content, { type: "text" as const, text }] };
  });

  pi.registerCommand("seo-guard", {
    description: "Scan the project for broken internal links, sitemap gaps, removed routes without redirects and missing title/description/canonical",
    handler: async (_args, ctx) => {
      const { config, error } = loadConfig(ctx.cwd);
      const report = formatScan(scanProject(ctx.cwd, config));
      ctx.ui.notify(error ? `${error}\n${report}` : report, "info");
      // Also put the report into the conversation so the agent can act on it.
      pi.sendMessage({ customType: "seo-guard", content: report, display: false }, { deliverAs: "nextTurn" });
    },
  });
}
