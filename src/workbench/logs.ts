/**
 * Workbench engine-log access.
 *
 * The Workbench editor is a GUI-subsystem process: build progress, script
 * compile diagnostics, and other results are written only to its engine log
 * files, never to stdout/stderr. Those logs live in per-session directories
 * and are appended incrementally while Workbench runs, so this module reads
 * them defensively (bounded reads, tolerant of files that are locked mid-write
 * on Windows, line-ending agnostic).
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";

/** Folder that holds Workbench profile data (addons/, logs/, profile/). */
const WORKBENCH_PROFILE_FOLDER = join("My Games", "ArmaReforgerWorkbench");
/** Subdirectory that holds the per-session logs_* directories. */
const LOGS_SUBDIR = "logs";
/** Prefix of a per-session log directory (e.g. logs_2026-07-19_11-18-31). */
const SESSION_DIR_PREFIX = "logs_";
/** Upper bound on how many bytes a single readLogTail call returns (~1 MiB). */
const MAX_TAIL_BYTES = 1024 * 1024;

export type IssueSeverity = "error" | "warning";

export interface ScriptIssue {
  severity: IssueSeverity;
  /** Source path as reported in the log, e.g. "scripts/Game/Foo.c". */
  file: string;
  /** 1-based line number reported in the log. */
  line: number;
  message: string;
}

export interface LogTail {
  /** Decoded text of the region that was read. */
  text: string;
  /** Byte offset just past the end of what was read — use as the next cursor. */
  endByte: number;
  /**
   * True when the region since the requested cursor was larger than the read
   * cap and only the tail cap-bytes were returned (earlier bytes were skipped).
   */
  truncated: boolean;
}

/**
 * Given a directory that is either a logs root itself or a profile folder that
 * contains one, return the directory that directly holds logs_* sessions, or
 * null if neither shape matches.
 */
function logsRootFrom(base: string): string | null {
  if (!base || !existsSync(base)) return null;
  // The directory already holds session subdirs.
  if (containsSessionDir(base)) return base;
  // A profile folder holds them under logs/.
  const nested = join(base, LOGS_SUBDIR);
  if (existsSync(nested) && statSync(nested).isDirectory()) return nested;
  return null;
}

function containsSessionDir(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(SESSION_DIR_PREFIX)) return true;
    }
  } catch {
    // Unreadable directory — treat as no match.
  }
  return false;
}

/**
 * Resolve the Workbench profile logs root — the directory that holds the
 * per-session logs_* subdirectories.
 *
 * Priority:
 *  1. config.workbenchProfileDir when set (may point at the profile folder or
 *     directly at a logs root).
 *  2. Auto-discovery under the user's Documents folder, which may live directly
 *     under the profile or be redirected into OneDrive.
 *
 * Returns null when nothing is found.
 */
export function resolveLogsRoot(config: Pick<Config, "workbenchProfileDir">): string | null {
  const configured = config.workbenchProfileDir;
  if (configured && configured.trim() !== "") {
    return logsRootFrom(configured);
  }

  const documentsCandidates = [
    join(homedir(), "Documents"),
    join(homedir(), "OneDrive", "Documents"),
  ];
  // Honour an explicit OneDrive relocation reported by the environment.
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer;
  if (oneDrive) {
    documentsCandidates.push(join(oneDrive, "Documents"));
  }

  for (const documents of documentsCandidates) {
    const root = logsRootFrom(join(documents, WORKBENCH_PROFILE_FOLDER));
    if (root) return root;
  }
  return null;
}

/**
 * Return the newest per-session logs_* directory under a logs root, or null
 * when there are none. Session directory names are timestamped, so lexical
 * ordering matches chronological ordering; modification time breaks any ties.
 */
export function findNewestSessionDir(root: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(SESSION_DIR_PREFIX))
      .map((e) => e.name);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  entries.sort((a, b) => {
    if (a !== b) return a < b ? 1 : -1; // name descending (newest first)
    return 0;
  });

  // Prefer name order, but fall back to mtime when names collide unexpectedly.
  let newest = entries[0];
  let newestMtime = safeMtime(join(root, newest));
  for (const name of entries.slice(1)) {
    if (name === newest) continue;
    const mtime = safeMtime(join(root, name));
    if (name > newest || (name === newest && mtime > newestMtime)) {
      newest = name;
      newestMtime = mtime;
    }
  }
  return join(root, newest);
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Incrementally read the tail of a log file.
 *
 * Reads at most MAX_TAIL_BYTES per call. When a cursor is supplied and the file
 * has grown by more than the cap, only the last cap-bytes of the new region are
 * returned and `truncated` is set. Reads that fail because the file is missing
 * or locked mid-write return empty text and the previous cursor so callers can
 * simply retry later.
 */
export function readLogTail(file: string, sinceByte?: number): LogTail {
  const previousCursor = sinceByte ?? 0;
  let fd: number | null = null;
  try {
    const size = statSync(file).size;

    // Cursor past the current end means the file was rotated/replaced — restart.
    let start = previousCursor;
    if (start > size) start = 0;

    const available = size - start;
    if (available <= 0) {
      return { text: "", endByte: size, truncated: false };
    }

    let readStart = start;
    let truncated = false;
    if (available > MAX_TAIL_BYTES) {
      readStart = size - MAX_TAIL_BYTES;
      truncated = true;
    }

    const length = size - readStart;
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(file, "r");
    let bytesRead = 0;
    while (bytesRead < length) {
      const n = readSync(fd, buffer, bytesRead, length - bytesRead, readStart + bytesRead);
      if (n <= 0) break;
      bytesRead += n;
    }

    return {
      text: buffer.subarray(0, bytesRead).toString("utf-8"),
      endByte: readStart + bytesRead,
      truncated,
    };
  } catch {
    // Missing file, locked file, or a transient Windows share violation.
    return { text: "", endByte: previousCursor, truncated: false };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
  }
}

/**
 * Matches a Workbench script diagnostic line. The severity marker, the quoted
 * "path,line" location, and the message are all captured; surrounding
 * whitespace varies between builds so it is treated loosely.
 */
const SCRIPT_ISSUE_RE = /SCRIPT\s*\(([EW])\)\s*:\s*@"(.+),(\d+)"\s*:\s*(.*)$/;

/**
 * Extract script compile errors and warnings from a block of log text.
 * Parsing is line-ending agnostic (handles CRLF and LF).
 */
export function parseScriptIssues(text: string): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const m = SCRIPT_ISSUE_RE.exec(rawLine);
    if (!m) continue;
    const [, marker, file, lineStr, message] = m;
    issues.push({
      severity: marker === "E" ? "error" : "warning",
      file: file.trim(),
      line: parseInt(lineStr, 10),
      message: message.trim(),
    });
  }
  return issues;
}

const CONTEXT_RADIUS = 5;

/**
 * Render an issue for display. When the referenced source file can be resolved
 * on disk relative to the given project/addon root, the offending line is shown
 * with ±5 lines of numbered context; otherwise the bare issue is returned.
 */
export function formatIssueWithContext(issue: ScriptIssue, projectRoot?: string): string {
  const marker = issue.severity === "error" ? "ERROR" : "WARN";
  const header = `[${marker}] ${issue.file}:${issue.line} — ${issue.message}`;

  const resolved = resolveSourceFile(issue.file, projectRoot);
  if (!resolved) return header;

  let contents: string;
  try {
    contents = readFileSync(resolved, "utf-8");
  } catch {
    return header;
  }

  const lines = contents.split(/\r?\n/);
  const target = issue.line - 1; // to 0-based
  if (target < 0 || target >= lines.length) return header;

  const from = Math.max(0, target - CONTEXT_RADIUS);
  const to = Math.min(lines.length - 1, target + CONTEXT_RADIUS);
  const width = String(to + 1).length;

  const rendered: string[] = [header, "```"];
  for (let i = from; i <= to; i++) {
    const num = String(i + 1).padStart(width, " ");
    const pointer = i === target ? ">" : " ";
    rendered.push(`${pointer} ${num} | ${lines[i]}`);
  }
  rendered.push("```");
  return rendered.join("\n");
}

function resolveSourceFile(file: string, projectRoot?: string): string | null {
  if (isAbsolute(file) && existsSync(file)) return file;
  if (!projectRoot) return null;
  const candidate = resolve(projectRoot, file);
  return existsSync(candidate) ? candidate : null;
}
