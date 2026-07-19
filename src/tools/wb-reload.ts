import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import type { WorkbenchClient } from "../workbench/client.js";
import type { Config } from "../config.js";
import { formatConnectionStatus } from "../workbench/status.js";
import {
  resolveLogsRoot,
  findNewestSessionDir,
  readLogTail,
  parseScriptIssues,
  formatIssueWithContext,
} from "../workbench/logs.js";

const CONSOLE_LOG = "console.log";
/** How often to poll the engine log for growth after triggering a reload. */
const LOG_POLL_INTERVAL_MS = 500;
/** Total time budget spent waiting for the log to reflect the reload. */
const LOG_POLL_BUDGET_MS = 5000;

export function registerWbReload(server: McpServer, client: WorkbenchClient, config: Config): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Reload scripts or plugins in the Workbench. Use after editing .c script files or Workbench plugins to pick up changes without restarting.",
      inputSchema: {
        target: z
          .enum(["scripts", "plugins", "both"])
          .default("scripts")
          .describe("What to reload: scripts, plugins, or both"),
      },
    },
    async ({ target }) => {
      // Snapshot the engine-log cursor before triggering the reload so we can
      // read only the output that the reload itself produces. Compile results
      // are written only to the log file, not returned over the NET API.
      const logFile = locateConsoleLog(config);
      const startCursor = logFile ? readLogTail(logFile).endByte : null;

      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target });

        const compileReport = logFile
          ? await pollCompileResult(logFile, startCursor ?? 0, config)
          : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `**Reload Complete**\n\n${result.message || "Reload triggered."}${compileReport}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error reloading: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}

/** Resolve the active session's console.log, or null if the logs root is unknown. */
function locateConsoleLog(config: Config): string | null {
  const root = resolveLogsRoot(config);
  if (!root) return null;
  const sessionDir = findNewestSessionDir(root);
  if (!sessionDir) return null;
  return join(sessionDir, CONSOLE_LOG);
}

/**
 * Poll the engine log for new output after a reload and summarise any new
 * script issues. Returns a markdown section to append to the tool result.
 * If the log never grows, says so explicitly rather than implying success.
 */
async function pollCompileResult(logFile: string, startCursor: number, config: Config): Promise<string> {
  const deadline = Date.now() + LOG_POLL_BUDGET_MS;
  let cursor = startCursor;
  let collected = "";
  let grew = false;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LOG_POLL_INTERVAL_MS));
    const tail = readLogTail(logFile, cursor);
    if (tail.endByte > cursor && tail.text.length > 0) {
      grew = true;
      collected += tail.text;
      cursor = tail.endByte;
    } else if (tail.endByte < cursor) {
      // The log was rotated/truncated under us — readLogTail restarted from
      // byte zero. Accept whatever the fresh file already contains and adopt
      // its cursor, otherwise output written before our next poll is lost.
      if (tail.text.length > 0) {
        grew = true;
        collected += tail.text;
      }
      cursor = tail.endByte;
    }
  }

  if (!grew) {
    return (
      "\n\n**Compile status: unconfirmed** — the engine log did not change after the reload, " +
      "so recompilation could not be verified. Check Workbench manually or read wb_log."
    );
  }

  const issues = parseScriptIssues(collected);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (issues.length === 0) {
    return "\n\n**Compile status: clean** — no new script errors or warnings in the reload output.";
  }

  const projectRoot = config.defaultMod ? join(config.projectPath, config.defaultMod) : config.projectPath;
  const lines: string[] = [
    `\n\n**Compile status: ${errors.length} error(s), ${warnings.length} warning(s)**`,
    "",
  ];
  for (const issue of issues) {
    lines.push(formatIssueWithContext(issue, projectRoot));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
