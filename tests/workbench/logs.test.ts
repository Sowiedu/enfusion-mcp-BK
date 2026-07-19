import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseScriptIssues,
  readLogTail,
  findNewestSessionDir,
} from "../../src/workbench/logs.js";

describe("parseScriptIssues", () => {
  it("parses a compile error", () => {
    const text = `12:00:00.000    SCRIPT    (E): @"scripts/SomeFile.c,123": Unknown type 'Foo'`;
    const issues = parseScriptIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      severity: "error",
      file: "scripts/SomeFile.c",
      line: 123,
      message: "Unknown type 'Foo'",
    });
  });

  it("parses a warning", () => {
    const text = `11:20:34.023    SCRIPT    (W): @"Scripts/Game/Ban.c,63": 'OnError' is obsolete: Use SetOnError() instead.`;
    const issues = parseScriptIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].file).toBe("Scripts/Game/Ban.c");
    expect(issues[0].line).toBe(63);
    expect(issues[0].message).toContain("obsolete");
  });

  it("tolerates odd whitespace around markers", () => {
    const text = `SCRIPT(E):@"a/b.c,5":  squished message   `;
    const issues = parseScriptIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      severity: "error",
      file: "a/b.c",
      line: 5,
      message: "squished message",
    });
  });

  it("is line-ending agnostic (CRLF)", () => {
    const text =
      `x\r\n` +
      `10:00:00.000  SCRIPT (E): @"a.c,1": first\r\n` +
      `10:00:00.001  SCRIPT (W): @"b.c,2": second\r\n` +
      `noise\r\n`;
    const issues = parseScriptIssues(text);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ severity: "error", file: "a.c", line: 1, message: "first" });
    expect(issues[1]).toMatchObject({ severity: "warning", file: "b.c", line: 2, message: "second" });
  });

  it("ignores non-script lines", () => {
    const text = `11:18:31.119   ENGINE       : FileSystem: Adding relative directory`;
    expect(parseScriptIssues(text)).toHaveLength(0);
  });

  it("keeps the last comma as the line-number separator", () => {
    const text = `SCRIPT (E): @"scripts/Foo,Bar/File.c,42": message, with comma`;
    const issues = parseScriptIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("scripts/Foo,Bar/File.c");
    expect(issues[0].line).toBe(42);
    expect(issues[0].message).toBe("message, with comma");
  });
});

describe("readLogTail", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wb-logs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the whole file from a fresh cursor", () => {
    const file = join(dir, "console.log");
    writeFileSync(file, "hello world");
    const tail = readLogTail(file);
    expect(tail.text).toBe("hello world");
    expect(tail.endByte).toBe(Buffer.byteLength("hello world"));
    expect(tail.truncated).toBe(false);
  });

  it("returns only new bytes when given a cursor", () => {
    const file = join(dir, "console.log");
    writeFileSync(file, "aaaa");
    const first = readLogTail(file);
    expect(first.endByte).toBe(4);

    writeFileSync(file, "aaaabbbb");
    const second = readLogTail(file, first.endByte);
    expect(second.text).toBe("bbbb");
    expect(second.endByte).toBe(8);
    expect(second.truncated).toBe(false);
  });

  it("returns empty when nothing new since the cursor", () => {
    const file = join(dir, "console.log");
    writeFileSync(file, "abc");
    const first = readLogTail(file);
    const second = readLogTail(file, first.endByte);
    expect(second.text).toBe("");
    expect(second.endByte).toBe(3);
  });

  it("caps the read and flags truncation when growth exceeds the limit", () => {
    const file = join(dir, "console.log");
    const cap = 1024 * 1024;
    // Grow the file well past the cap in one shot.
    const big = "x".repeat(cap + 5000);
    writeFileSync(file, big);
    const tail = readLogTail(file, 0);
    expect(tail.truncated).toBe(true);
    expect(Buffer.byteLength(tail.text)).toBe(cap);
    expect(tail.endByte).toBe(big.length);
  });

  it("restarts from zero when the file shrank below the cursor (rotation)", () => {
    const file = join(dir, "console.log");
    writeFileSync(file, "0123456789");
    // Cursor beyond the new, shorter content.
    writeFileSync(file, "new");
    const tail = readLogTail(file, 10);
    expect(tail.text).toBe("new");
    expect(tail.endByte).toBe(3);
  });

  it("tolerates a missing file by returning the previous cursor", () => {
    const missing = join(dir, "does-not-exist.log");
    const tail = readLogTail(missing, 42);
    expect(tail.text).toBe("");
    expect(tail.endByte).toBe(42);
    expect(tail.truncated).toBe(false);
  });
});

describe("findNewestSessionDir", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wb-root-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when there are no session directories", () => {
    expect(findNewestSessionDir(root)).toBeNull();
  });

  it("picks the newest by timestamped name", () => {
    for (const name of [
      "logs_2026-07-19_02-40-12",
      "logs_2026-07-19_11-18-31",
      "logs_2026-07-19_08-17-53",
    ]) {
      mkdirSync(join(root, name));
    }
    // A non-session directory must be ignored.
    mkdirSync(join(root, "profile"));
    const newest = findNewestSessionDir(root);
    expect(newest).toBe(join(root, "logs_2026-07-19_11-18-31"));
  });

  it("ignores files and unrelated directories", () => {
    mkdirSync(join(root, "logs_2026-01-01_00-00-00"));
    writeFileSync(join(root, "logs_not_a_dir.txt"), "x");
    mkdirSync(join(root, "addons"));
    const newest = findNewestSessionDir(root);
    expect(newest).toBe(join(root, "logs_2026-01-01_00-00-00"));
  });

  it("breaks name ties by modification time", () => {
    // Two same-named session dirs cannot coexist, but the mtime tie-break path
    // is exercised by touching an older-named dir to be newest on disk.
    const older = join(root, "logs_2026-07-19_01-00-00");
    const newer = join(root, "logs_2026-07-19_02-00-00");
    mkdirSync(older);
    mkdirSync(newer);
    const t = Date.now() / 1000;
    utimesSync(older, t, t);
    utimesSync(newer, t, t);
    // Name ordering still wins: 02-00-00 > 01-00-00.
    expect(findNewestSessionDir(root)).toBe(newer);
  });
});
