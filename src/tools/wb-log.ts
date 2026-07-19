import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import {
  resolveLogsRoot,
  findNewestSessionDir,
  readLogTail,
  parseScriptIssues,
  formatIssueWithContext,
} from "../workbench/logs.js";

const CONSOLE_LOG = "console.log";
const DEFAULT_LINES = 100;

/**
 * Read the Workbench engine log for the active editor session.
 *
 * Workbench is a GUI-subsystem process: build progress and script compile
 * diagnostics go only to its engine log files, never to stdout/stderr. When
 * script compilation itself fails, the in-engine NET API handlers do not load,
 * so in-engine queries are unavailable and this file-based reader is the only
 * reliable error channel. The tool reports the session it read, the tail (or
 * only the parsed issues), and a byte cursor so agents can poll incrementally.
 */
export function registerWbLog(server: McpServer, config: Config): void {
  server.registerTool(
    "wb_log",
    {
      description:
        "Read the Workbench engine log (console.log) for the active editor session. " +
        "Reports script compile errors/warnings and build output that Workbench writes " +
        "only to its log files. Returns a byte cursor so you can poll incrementally by " +
        "passing it back as sinceByte. Use errorsOnly to get just parsed script issues.",
      inputSchema: {
        lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Number of trailing log lines to return (default ${DEFAULT_LINES}). Ignored when errorsOnly is true.`),
        errorsOnly: z
          .boolean()
          .optional()
          .describe("Return only parsed script compile errors/warnings (with source context) instead of raw log text."),
        sinceByte: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Byte offset to resume from (the cursor returned by a previous call). Omit to read the current tail."),
      },
    },
    async ({ lines, errorsOnly, sinceByte }) => {
      const logsRoot = resolveLogsRoot(config);
      if (!logsRoot) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No Workbench logs root found.\n\n" +
                "Set the profile directory so the log can be located:\n" +
                "  - config field `workbenchProfileDir`, or\n" +
                "  - env var ENFUSION_WORKBENCH_PROFILE_DIR\n\n" +
                "Point it at your \"My Games/ArmaReforgerWorkbench\" folder (or directly at its `logs` directory).",
            },
          ],
          isError: true,
        };
      }

      const sessionDir = findNewestSessionDir(logsRoot);
      if (!sessionDir) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No session log directories (logs_*) found under:\n  ${logsRoot}\n\nStart Workbench so it creates a session log.`,
            },
          ],
          isError: true,
        };
      }

      const logFile = join(sessionDir, CONSOLE_LOG);
      const tail = readLogTail(logFile, sinceByte);

      const header: string[] = [
        `**Session:** ${basename(sessionDir)}`,
        `**Log:** ${logFile}`,
        `**Cursor:** ${tail.endByte} (pass as sinceByte to resume)`,
      ];
      if (tail.truncated) {
        header.push("**Note:** new region exceeded the 1 MiB read cap — earlier bytes were skipped.");
      }

      if (errorsOnly) {
        const issues = parseScriptIssues(tail.text);
        const projectRoot = config.defaultMod
          ? join(config.projectPath, config.defaultMod)
          : config.projectPath;
        const body =
          issues.length === 0
            ? "No script compile errors or warnings in this region."
            : issues.map((i) => formatIssueWithContext(i, projectRoot)).join("\n\n");
        const errorCount = issues.filter((i) => i.severity === "error").length;
        const warnCount = issues.length - errorCount;
        header.push(`**Issues:** ${errorCount} error(s), ${warnCount} warning(s)`);
        return {
          content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${body}` }],
        };
      }

      const limit = lines ?? DEFAULT_LINES;
      const allLines = tail.text.split(/\r?\n/);
      const shown = allLines.slice(-limit).join("\n");
      const body = tail.text.length === 0 ? "(no new log output)" : shown;
      return {
        content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${body}` }],
      };
    }
  );
}
