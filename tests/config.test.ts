import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { loadConfig } from "../src/config.js";

// loadConfig reads ENFUSION_MOD_PATHS from the environment. Save/restore it so
// these cases stay isolated from each other and from the ambient environment.
const ENV_KEY = "ENFUSION_MOD_PATHS";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
});

describe("config modPaths", () => {
  it("parses a comma-separated ENFUSION_MOD_PATHS", () => {
    process.env[ENV_KEY] = "C:/mods/a,C:/mods/b,C:/mods/c";
    expect(loadConfig().modPaths).toEqual(["C:/mods/a", "C:/mods/b", "C:/mods/c"]);
  });

  it("parses a semicolon-separated ENFUSION_MOD_PATHS", () => {
    process.env[ENV_KEY] = "C:/mods/a;C:/mods/b";
    expect(loadConfig().modPaths).toEqual(["C:/mods/a", "C:/mods/b"]);
  });

  it("accepts a mix of comma and semicolon separators", () => {
    process.env[ENV_KEY] = "C:/mods/a,C:/mods/b;C:/mods/c";
    expect(loadConfig().modPaths).toEqual(["C:/mods/a", "C:/mods/b", "C:/mods/c"]);
  });

  it("trims surrounding whitespace around each entry", () => {
    process.env[ENV_KEY] = "  C:/mods/a  ;  C:/mods/b  ";
    expect(loadConfig().modPaths).toEqual(["C:/mods/a", "C:/mods/b"]);
  });

  it("drops empty and whitespace-only entries", () => {
    process.env[ENV_KEY] = "C:/mods/a,, ,;;C:/mods/b,";
    expect(loadConfig().modPaths).toEqual(["C:/mods/a", "C:/mods/b"]);
  });

  it("auto-discovers only directories that actually exist when unset", () => {
    // With the env override removed, modPaths falls back to auto-discovery. The
    // result is machine-dependent, but every discovered path MUST exist on disk
    // (and on a machine without the game the list is simply empty).
    const modPaths = loadConfig().modPaths;
    expect(Array.isArray(modPaths)).toBe(true);
    for (const p of modPaths!) {
      expect(existsSync(p), `discovered mod path should exist: ${p}`).toBe(true);
    }
  });
});
