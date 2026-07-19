import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, extname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import { generateGproj } from "../templates/gproj.js";
import { generateScript } from "../templates/script.js";
import type { PatternLibrary } from "../patterns/loader.js";
import { validateFilename, validateProjectPath } from "../utils/safe-path.js";
import type { SearchEngine } from "../index/search-engine.js";
import { parse, getProperty } from "../formats/enfusion-text.js";

// ─── build helpers ────────────────────────────────────────────────────────────

const WORKBENCH_DIAG_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const BUILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function findWorkbenchExe(workbenchPath: string): string | null {
  // Check Workbench subdirectory first (standard Steam layout: "Arma Reforger Tools/Workbench/")
  const subPath = join(workbenchPath, "Workbench", WORKBENCH_DIAG_EXE);
  if (existsSync(subPath)) return subPath;

  // Check root (in case config points directly to Workbench/)
  const rootPath = join(workbenchPath, WORKBENCH_DIAG_EXE);
  if (existsSync(rootPath)) return rootPath;

  return null;
}

/**
 * Run a Workbench build and detect completion by TAILING THE ENGINE LOG.
 *
 * Workbench is a GUI app: `-buildData` compiles/builds but the process then
 * stays open in the GUI forever — it never exits on its own. Waiting for
 * process exit therefore always hits the timeout. Instead we poll console.log
 * in `logsDir` until the startup/compile completion marker appears and the log
 * stops growing, then we terminate Workbench ourselves and report from the log.
 */
export function runBuild(
  exePath: string,
  args: string[],
  logsDir: string,
  timeoutMs: number
): Promise<{ completed: boolean; killedAfterComplete: boolean; stderr: string; timedOut: boolean; logText: string }> {
  const POLL_MS = 1000;
  // After the completion marker, wait for the log to be quiet this long
  // (covers post-compile build activity that -buildData may still perform).
  const QUIET_MS = 5000;
  const COMPLETION_MARKER = /Workbench startup took:|Compiling Game scripts took:/;

  return new Promise((resolvePromise) => {
    let stderr = "";
    let settled = false;

    const proc = spawn(exePath, args, {
      windowsHide: true,
    });

    proc.stdout.on("data", () => { /* GUI app — stdout carries nothing useful */ });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const readLog = (): string => {
      let text = "";
      for (const logFile of findConsoleLogs(logsDir)) {
        try {
          text += readFileSync(logFile, "utf-8") + "\n";
        } catch {
          // may be locked mid-write — retry next poll
        }
      }
      return text;
    };

    const finish = (result: { completed: boolean; killedAfterComplete: boolean; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timer);
      const logText = readLog();
      if (result.killedAfterComplete || result.timedOut) {
        try {
          proc.kill();
        } catch {
          // already gone
        }
      }
      resolvePromise({ ...result, stderr, logText });
    };

    let markerSeen = false;
    let lastLogLen = -1;
    let lastGrowth = Date.now();

    const poller = setInterval(() => {
      const text = readLog();
      if (text.length !== lastLogLen) {
        lastLogLen = text.length;
        lastGrowth = Date.now();
      }
      if (!markerSeen && COMPLETION_MARKER.test(text)) {
        markerSeen = true;
      }
      if (markerSeen && Date.now() - lastGrowth >= QUIET_MS) {
        finish({ completed: true, killedAfterComplete: true, timedOut: false });
      }
    }, POLL_MS);

    const timer = setTimeout(() => {
      finish({ completed: markerSeen, killedAfterComplete: markerSeen, timedOut: true });
    }, timeoutMs);

    // If the process DOES exit on its own (e.g. fatal error, future versions), use that.
    proc.on("close", () => {
      finish({ completed: markerSeen, killedAfterComplete: false, timedOut: false });
    });

    proc.on("error", (err) => {
      stderr += `\nProcess error: ${err.message}`;
      finish({ completed: false, killedAfterComplete: false, timedOut: false });
    });
  });
}

/**
 * Workbench is a GUI-subsystem app: build progress, script compile errors and
 * results go to its engine log (console.log), NOT to stdout/stderr. Find all
 * console.log files under the redirected logs directory.
 */
function findConsoleLogs(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findConsoleLogs(p));
    else if (entry.name.toLowerCase() === "console.log") out.push(p);
  }
  return out;
}

// ─── create helpers ───────────────────────────────────────────────────────────

/**
 * Derive a 2-4 character prefix from the mod name.
 * "MyCustomMod" → "MCM", "ZombieDefense" → "ZD"
 */
function derivePrefix(name: string): string {
  // Extract uppercase letters
  const uppers = name.replace(/[^A-Z]/g, "");
  if (uppers.length >= 2 && uppers.length <= 4) return uppers;
  if (uppers.length > 4) return uppers.slice(0, 3);

  // Fallback: first 3 chars uppercased
  return name.slice(0, 3).toUpperCase();
}

// ─── validate helpers ─────────────────────────────────────────────────────────

interface ValidationIssue {
  level: "error" | "warning" | "info";
  message: string;
}

type CheckName = "structure" | "gproj" | "scripts" | "prefabs" | "configs" | "references" | "naming";

const ALL_CHECKS: CheckName[] = ["structure", "gproj", "scripts", "prefabs", "configs", "references", "naming"];

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const walk = (current: string) => {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (extname(entry.name).toLowerCase() === ext) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };
  walk(dir);
  return results;
}

function checkStructure(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check for .gproj file
  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) {
    issues.push({ level: "error", message: "No .gproj file found in project root" });
  } else if (gprojFiles.length > 1) {
    issues.push({ level: "warning", message: `Multiple .gproj files found: ${gprojFiles.join(", ")}` });
  }

  // Check standard directories
  const expectedDirs = ["Scripts/Game"];
  for (const dir of expectedDirs) {
    if (!existsSync(resolve(projectPath, dir))) {
      issues.push({ level: "warning", message: `Missing expected directory: ${dir}` });
    }
  }

  return issues;
}

function checkGproj(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) return issues;

  for (const filename of gprojFiles) {
    const filepath = resolve(projectPath, filename);
    try {
      const content = readFileSync(filepath, "utf-8");
      const node = parse(content);

      if (node.type !== "GameProject") {
        issues.push({ level: "error", message: `${filename}: Root node is "${node.type}", expected "GameProject"` });
      }

      const id = getProperty(node, "ID");
      if (!id) {
        issues.push({ level: "error", message: `${filename}: Missing ID field` });
      }

      const guid = getProperty(node, "GUID");
      if (!guid) {
        issues.push({ level: "error", message: `${filename}: Missing GUID field` });
      } else if (typeof guid === "string" && !/^[0-9A-Fa-f]{16}$/.test(guid)) {
        issues.push({ level: "warning", message: `${filename}: GUID "${guid}" is not a valid 16-char hex string` });
      }

      const deps = node.children.find((c) => c.type === "Dependencies");
      if (!deps) {
        issues.push({ level: "error", message: `${filename}: Missing Dependencies block — mod won't load` });
      } else if (!deps.values.includes("58D0FB3206B6F859")) {
        issues.push({ level: "error", message: `${filename}: Missing base game dependency (58D0FB3206B6F859)` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({ level: "error", message: `${filename}: Failed to parse — ${msg}` });
    }
  }

  return issues;
}

function checkScripts(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Find all .c files in the project
  const allScripts = findFiles(projectPath, ".c");

  for (const scriptPath of allScripts) {
    const rel = relative(projectPath, scriptPath).replace(/\\/g, "/");

    // Check if script is in a valid module folder
    if (!rel.startsWith("Scripts/Game/") && !rel.startsWith("Scripts/GameLib/") && !rel.startsWith("Scripts/WorkbenchGame/")) {
      issues.push({
        level: "error",
        message: `${rel}: Script is outside a valid module folder (Scripts/Game/, Scripts/GameLib/, Scripts/WorkbenchGame/) — it will be silently ignored`,
      });
      continue;
    }

    // Basic syntax check: look for class declaration
    try {
      const content = readFileSync(scriptPath, "utf-8");
      const hasClass = /\b(class|modded\s+class)\s+\w+/.test(content);
      if (!hasClass) {
        issues.push({
          level: "warning",
          message: `${rel}: No class declaration found`,
        });
      }
    } catch {
      issues.push({
        level: "warning",
        message: `${rel}: Could not read file`,
      });
    }
  }

  return issues;
}

function checkPrefabs(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allPrefabs = findFiles(projectPath, ".et");

  for (const prefabPath of allPrefabs) {
    const rel = relative(projectPath, prefabPath).replace(/\\/g, "/");

    try {
      const content = readFileSync(prefabPath, "utf-8");
      parse(content); // Just verify it parses
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({
        level: "error",
        message: `${rel}: Invalid prefab format — ${msg}`,
      });
    }
  }

  return issues;
}

function checkConfigs(projectPath: string, searchEngine?: SearchEngine): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allConfigs = findFiles(projectPath, ".conf");

  for (const configPath of allConfigs) {
    const rel = relative(projectPath, configPath).replace(/\\/g, "/");
    try {
      const content = readFileSync(configPath, "utf-8");
      const root = parse(content);

      // Check root node type against API index (only if searchEngine available)
      if (searchEngine && root.type && !searchEngine.hasClass(root.type)) {
        issues.push({
          level: "warning",
          message: `${rel}: Root class "${root.type}" not found in API index — may be from another mod or misspelled.`,
        });
      }

      // Walk children and check their type names
      if (searchEngine) {
        const walkNodes = (node: ReturnType<typeof parse>) => {
          for (const child of node.children || []) {
            if (child.type && /^[A-Z]/.test(child.type) && !searchEngine.hasClass(child.type)) {
              issues.push({
                level: "warning",
                message: `${rel}: Class "${child.type}" not found in API index.`,
              });
            }
            walkNodes(child);
          }
        };
        walkNodes(root);
      }

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({
        level: "error",
        message: `${rel}: Invalid config format — ${msg}`,
      });
    }
  }

  return issues;
}

function checkReferences(projectPath: string, searchEngine: SearchEngine): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allScripts = findFiles(projectPath, ".c");

  for (const scriptPath of allScripts) {
    const rel = relative(projectPath, scriptPath).replace(/\\/g, "/");

    try {
      const content = readFileSync(scriptPath, "utf-8");

      // Extract parent class from class declarations
      const classMatch = content.match(/(?:modded\s+)?class\s+\w+\s*:\s*(\w+)/);
      if (classMatch) {
        const parentClass = classMatch[1];
        if (!searchEngine.hasClass(parentClass)) {
          issues.push({
            level: "warning",
            message: `${rel}: Extends "${parentClass}" which is not in the API index (may be from another mod)`,
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return issues;
}

function checkNaming(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allScripts = findFiles(projectPath, ".c");
  const prefixes: Map<string, number> = new Map();

  for (const scriptPath of allScripts) {
    try {
      const content = readFileSync(scriptPath, "utf-8");
      const classMatch = content.match(/(?:modded\s+)?class\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[1];
        // Extract prefix (part before first underscore)
        const prefixMatch = className.match(/^([A-Z]+)_/);
        if (prefixMatch) {
          const prefix = prefixMatch[1];
          prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
        }
      }
    } catch {
      // Skip
    }
  }

  // Find the most common prefix
  if (prefixes.size > 1) {
    let maxPrefix = "";
    let maxCount = 0;
    for (const [prefix, count] of prefixes) {
      if (count > maxCount) {
        maxPrefix = prefix;
        maxCount = count;
      }
    }

    for (const [prefix, count] of prefixes) {
      if (prefix !== maxPrefix) {
        issues.push({
          level: "info",
          message: `${count} class(es) use prefix "${prefix}_" instead of the most common prefix "${maxPrefix}_"`,
        });
      }
    }
  }

  return issues;
}

// ─── registerMod ──────────────────────────────────────────────────────────────

export function registerMod(
  server: McpServer,
  config: Config,
  searchEngine: SearchEngine,
  patterns: PatternLibrary
): void {
  server.registerTool(
    "mod",
    {
      description:
        "Manage Arma Reforger addons: build with the Workbench CLI, scaffold a new addon, or validate an existing addon without building.",
      inputSchema: {
        action: z
          .enum(["build", "create", "validate"])
          .describe("Action to perform: 'build' compiles the addon, 'create' scaffolds a new addon, 'validate' checks an existing addon."),

        // ── build params ──────────────────────────────────────────────────────
        addonName: z
          .string()
          .min(1)
          .optional()
          .describe("(build) Name of the addon to build (must match the .gproj ID)"),
        platform: z
          .enum(["PC", "PC_WB", "HEADLESS"])
          .default("PC")
          .optional()
          .describe("(build) Target platform for the build"),
        outputPath: z
          .string()
          .optional()
          .describe("(build) Build output directory. Auto-generated if omitted."),
        gprojPath: z
          .string()
          .optional()
          .describe("(build) Path to .gproj file. Auto-detected if omitted."),
        filterPath: z
          .string()
          .optional()
          .describe("(build) Limit build to a single folder or file for faster iteration"),

        // ── create params ─────────────────────────────────────────────────────
        name: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("(create) Addon name (e.g., 'MyCustomMod'). Used as the project folder name."),
        description: z
          .string()
          .optional()
          .describe("(create) Brief description of what the mod does"),
        prefix: z
          .string()
          .min(1)
          .max(4)
          .optional()
          .describe("(create) Class name prefix (e.g., 'MCM'). Auto-derived from name if omitted."),
        pattern: z
          .string()
          .optional()
          .describe("(create) Mod pattern to apply (e.g., 'custom-faction', 'game-mode'). Use without this to get a bare scaffold."),
        projectPath: z
          .string()
          .optional()
          .describe("(create/validate) Parent directory where the addon folder will be created (create), or addon root directory (validate). Uses configured default if omitted."),

        // ── validate params ───────────────────────────────────────────────────
        checks: z
          .array(z.enum(["structure", "gproj", "scripts", "prefabs", "configs", "references", "naming"]))
          .optional()
          .describe("(validate) Specific checks to run. Runs all checks if omitted."),
      },
    },
    async ({ action, addonName, platform, outputPath, gprojPath, filterPath, name, description, prefix, pattern: patternName, projectPath, checks }) => {

      // ── build ──────────────────────────────────────────────────────────────
      if (action === "build") {
        if (!addonName) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'build': addonName" }],
            isError: true,
          };
        }

        const exePath = findWorkbenchExe(config.workbenchPath);
        if (!exePath) {
          return {
            content: [
              {
                type: "text",
                text: `Workbench not found at: ${config.workbenchPath}\n\n${WORKBENCH_DIAG_EXE} is required for building.\n\nInstall Arma Reforger Tools from Steam, or set ENFUSION_WORKBENCH_PATH to the correct path.\n\nNote: You need the Diag version (opt into "Profiling Build" beta in Steam).`,
              },
            ],
            isError: true,
          };
        }

        // Program Files is not writable without elevation — default to temp.
        const buildOutput =
          outputPath ||
          join(tmpdir(), "enfusion-mcp-build", addonName, "output");

        const args: string[] = [
          "-wbModule=ResourceManager",
          `-buildData`,
          platform ?? "PC",
          buildOutput,
          addonName,
        ];

        if (gprojPath) {
          args.push(`-gproj`, gprojPath);
        }

        if (filterPath) {
          args.push(`-filterPath`, filterPath);
        }

        // Register the base game data addon. Without this, addon dependencies on
        // the vanilla game ("ArmaReforger") cannot resolve and Workbench blocks on
        // a modal "Missing Addon" dialog until the timeout kills the process.
        const gameAddonsDir = join(config.gamePath, "addons");
        if (existsSync(gameAddonsDir)) {
          args.push("-addonsDir", gameAddonsDir);
        }

        // Redirect the engine log to a directory we control. Workbench is a GUI
        // app — compile errors and build results only appear in console.log.
        const logsDir = join(tmpdir(), "enfusion-mcp-build", addonName, `logs-${Date.now()}`);
        mkdirSync(logsDir, { recursive: true });
        args.push("-logsDir", logsDir);

        try {
          const startTime = Date.now();
          const result = await runBuild(exePath, args, logsDir, BUILD_TIMEOUT_MS);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          let logText = result.logText;

          // Fallback: if -logsDir was ignored, scan the default Workbench logs
          // root for log directories created after we spawned the process.
          if (!logText.trim()) {
            const defaultLogsRoot = resolve(config.projectPath, "..", "logs");
            if (existsSync(defaultLogsRoot)) {
              for (const entry of readdirSync(defaultLogsRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const dirPath = join(defaultLogsRoot, entry.name);
                try {
                  if (statSync(dirPath).mtimeMs < startTime) continue;
                } catch {
                  continue;
                }
                for (const logFile of findConsoleLogs(dirPath)) {
                  try {
                    logText += readFileSync(logFile, "utf-8") + "\n";
                  } catch {
                    // locked — skip
                  }
                }
              }
            }
          }

          const logLines = logText.split("\n");
          const scriptErrors = logLines.filter((l) => /SCRIPT\s+\(E\)/.test(l));
          const engineErrors = logLines.filter((l) => /\w+\s+\(E\)\s*:/.test(l) && !/SCRIPT\s+\(E\)/.test(l));
          const scriptsCompiled = /Compiling Game scripts took:/.test(logText);

          const lines: string[] = [];
          lines.push(`## Build Result: ${addonName}`);
          lines.push("");

          if (scriptErrors.length > 0) {
            lines.push(`**Status:** SCRIPT COMPILE FAILED (${scriptErrors.length} error line(s))`);
          } else if (result.completed && scriptsCompiled) {
            lines.push("**Status:** SUCCESS — scripts compiled clean");
            lines.push(`**Output:** ${buildOutput}`);
          } else if (result.timedOut) {
            lines.push(`**Status:** TIMEOUT (no completion marker within ${BUILD_TIMEOUT_MS / 1000}s)`);
            lines.push("Workbench may be blocked on a modal dialog — check the engine log below.");
          } else {
            lines.push("**Status:** INCOMPLETE — process ended before the compile finished");
          }
          lines.push(`**Build time:** ${elapsed}s`);
          if (result.killedAfterComplete) {
            lines.push("_(Workbench does not exit after -buildData; the process was terminated after the log went quiet.)_");
          }

          lines.push("");
          lines.push(`**Command:** ${WORKBENCH_DIAG_EXE} ${args.join(" ")}`);
          lines.push(`**Engine log:** ${logsDir}`);

          if (scriptErrors.length > 0) {
            lines.push("");
            lines.push("### Script errors");
            lines.push("```");
            lines.push(scriptErrors.slice(0, 50).join("\n"));
            if (scriptErrors.length > 50) {
              lines.push(`... (${scriptErrors.length - 50} more — see engine log)`);
            }
            lines.push("```");
          }

          if (engineErrors.length > 0) {
            lines.push("");
            lines.push("### Engine errors (non-script)");
            lines.push("```");
            lines.push(engineErrors.slice(0, 20).join("\n"));
            if (engineErrors.length > 20) {
              lines.push(`... (${engineErrors.length - 20} more — see engine log)`);
            }
            lines.push("```");
          }

          if (scriptErrors.length === 0 && !(result.completed && scriptsCompiled) && logText.trim()) {
            lines.push("");
            lines.push("### Engine log tail");
            lines.push("```");
            lines.push(logLines.filter((l) => l.trim()).slice(-30).join("\n"));
            lines.push("```");
          }

          if (result.stderr.trim()) {
            lines.push("");
            lines.push("### Process stderr");
            lines.push("```");
            const stderrLines = result.stderr.trim().split("\n");
            lines.push(stderrLines.slice(-20).join("\n"));
            lines.push("```");
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error running build: ${msg}` }],
            isError: true,
          };
        }
      }

      // ── create ─────────────────────────────────────────────────────────────
      if (action === "create") {
        if (!name) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'create': name" }],
            isError: true,
          };
        }

        const basePath = projectPath || config.projectPath;

        if (!basePath) {
          return {
            content: [
              {
                type: "text",
                text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
              },
            ],
            isError: true,
          };
        }

        try {
          validateFilename(name);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Invalid addon name: ${msg}` }],
            isError: true,
          };
        }

        // Validate pattern before creating any directories
        if (patternName) {
          const patternDef = patterns.get(patternName);
          if (!patternDef) {
            const available = patterns.list().join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown pattern: "${patternName}"\nAvailable patterns: ${available}`,
                },
              ],
            };
          }
        }

        const addonDir = resolve(basePath, name);
        const classPrefix = prefix ?? derivePrefix(name);

        if (existsSync(addonDir)) {
          return {
            content: [
              {
                type: "text",
                text: `Directory already exists: ${addonDir}\nUse a different name or delete the existing directory.`,
              },
            ],
          };
        }

        try {
          const createdFiles: string[] = [];

          // Create directory structure
          const dirs = [
            addonDir,
            join(addonDir, "Scripts", "Game"),
            join(addonDir, "Prefabs"),
            join(addonDir, "PrefabsEditable"),
            join(addonDir, "Configs"),
            join(addonDir, "Language"),
            join(addonDir, "Missions"),
            join(addonDir, "UI"),
            join(addonDir, "Worlds"),
          ];
          for (const dir of dirs) {
            mkdirSync(dir, { recursive: true });
          }

          // Generate and write .gproj
          const gprojContent = generateGproj({
            name,
            title: name,
          });
          const gprojFilePath = join(addonDir, `${name}.gproj`);
          writeFileSync(gprojFilePath, gprojContent, "utf-8");
          createdFiles.push(`${name}.gproj`);

          // Apply pattern if specified (already validated above)
          if (patternName) {
            const patternDef = patterns.get(patternName)!;

            // Check for filename collisions after prefix replacement
            const scriptPaths: string[] = [];
            for (const scriptDef of patternDef.scripts) {
              const className = scriptDef.className.replace(/\{PREFIX\}/g, classPrefix);
              const path = `Scripts/Game/${className}.c`;
              if (scriptPaths.includes(path)) {
                return {
                  content: [{
                    type: "text",
                    text: `Pattern "${patternName}" produces duplicate script file after prefix replacement: ${path}\nUse a different prefix to avoid collisions.`,
                  }],
                };
              }
              scriptPaths.push(path);
            }

            const configPaths: string[] = [];
            for (const configDef of patternDef.configs) {
              const configName = configDef.name.replace(/\{PREFIX\}/g, classPrefix);
              const path = `Configs/${configName}.conf`;
              if (configPaths.includes(path)) {
                return {
                  content: [{
                    type: "text",
                    text: `Pattern "${patternName}" produces duplicate config file after prefix replacement: ${path}\nUse a different prefix to avoid collisions.`,
                  }],
                };
              }
              configPaths.push(path);
            }

            // Generate scripts from pattern
            for (const scriptDef of patternDef.scripts) {
              const className = scriptDef.className.replace(/\{PREFIX\}/g, classPrefix);
              const code = generateScript({
                className,
                scriptType: scriptDef.scriptType as any,
                parentClass: scriptDef.parentClass || undefined,
                methods: scriptDef.methods.length > 0 ? scriptDef.methods : undefined,
                description: scriptDef.description,
              });
              const scriptPath = join(addonDir, "Scripts", "Game", `${className}.c`);
              writeFileSync(scriptPath, code, "utf-8");
              createdFiles.push(`Scripts/Game/${className}.c`);
            }

            // Create prefab subdirectories from pattern
            for (const prefabDef of patternDef.prefabs) {
              const prefabName = prefabDef.name.replace(/\{PREFIX\}/g, classPrefix);
              // Ensure directory exists (prefabs go in type-specific subdirs)
              const prefabDir = join(addonDir, "Prefabs");
              mkdirSync(prefabDir, { recursive: true });
              // Note: prefab file generation is done via prefab_create tool for full control
              createdFiles.push(`(Use prefab_create for: ${prefabName})`);
            }

            // Apply pattern configs
            for (const configDef of patternDef.configs) {
              const configName = configDef.name.replace(/\{PREFIX\}/g, classPrefix);
              const configContent = configDef.content.replace(/\{PREFIX\}/g, classPrefix);
              const targetPath = join(addonDir, "Configs", `${configName}.conf`);
              mkdirSync(resolve(targetPath, ".."), { recursive: true });
              writeFileSync(targetPath, configContent, "utf-8");
              createdFiles.push(`Configs/${configName}.conf`);
            }
          }

          // Build response
          const lines: string[] = [];
          lines.push(`## Addon Created: ${name}`);
          lines.push(`Path: ${addonDir}`);
          lines.push(`Class prefix: ${classPrefix}`);
          lines.push("");
          lines.push("### Created Files");
          for (const f of createdFiles) {
            lines.push(`- ${f}`);
          }
          lines.push("");
          lines.push("### Directory Structure");
          lines.push(`${name}/`);
          lines.push(`  ${name}.gproj`);
          lines.push("  Scripts/");
          lines.push("    Game/");
          if (createdFiles.some((f) => f.startsWith("Scripts/"))) {
            for (const f of createdFiles) {
              if (f.startsWith("Scripts/Game/")) {
                lines.push(`      ${f.replace("Scripts/Game/", "")}`);
              }
            }
          }
          lines.push("  Prefabs/");
          lines.push("  PrefabsEditable/");
          lines.push("  Configs/");
          if (createdFiles.some((f) => f.startsWith("Configs/"))) {
            for (const f of createdFiles) {
              if (f.startsWith("Configs/")) {
                lines.push(`    ${f.replace("Configs/", "")}`);
              }
            }
          }
          lines.push("  Language/");
          lines.push("  Missions/");
          lines.push("  UI/");
          lines.push("  Worlds/");
          lines.push("");
          lines.push("Addon scaffold is ready. Proceeding with file generation and Workbench integration automatically.");

          if (patternName) {
            const patternDef = patterns.get(patternName);
            if (patternDef?.instructions) {
              lines.push("");
              lines.push("### Pattern Instructions");
              lines.push(patternDef.instructions);
            }
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error creating addon: ${msg}` }],
            isError: true,
          };
        }
      }

      // ── validate ───────────────────────────────────────────────────────────
      // action === "validate"
      let basePath: string;
      if (projectPath) {
        // Validate user-supplied path is within the configured project directory
        try {
          basePath = validateProjectPath(config.projectPath, projectPath);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `Invalid project path: "${projectPath}". Path must be within the configured project directory (${config.projectPath}).`,
              },
            ],
          };
        }
      } else {
        basePath = config.projectPath;
      }

      if (!basePath) {
        return {
          content: [
            {
              type: "text",
              text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
            },
          ],
          isError: true,
        };
      }

      if (!existsSync(basePath)) {
        return {
          content: [
            { type: "text", text: `Project directory not found: ${basePath}` },
          ],
          isError: true,
        };
      }

      const enabledChecks = (checks as CheckName[] | undefined) ?? ALL_CHECKS;
      const allIssues: ValidationIssue[] = [];

      const checkMap: Record<CheckName, () => ValidationIssue[]> = {
        structure: () => checkStructure(basePath),
        gproj: () => checkGproj(basePath),
        scripts: () => checkScripts(basePath),
        prefabs: () => checkPrefabs(basePath),
        configs: () => checkConfigs(basePath, searchEngine),
        references: () => checkReferences(basePath, searchEngine),
        naming: () => checkNaming(basePath),
      };

      const passedChecks: string[] = [];

      for (const check of enabledChecks) {
        const issues = checkMap[check]();
        if (issues.length === 0) {
          passedChecks.push(check);
        }
        allIssues.push(...issues);
      }

      // Format report
      const errors = allIssues.filter((i) => i.level === "error");
      const warnings = allIssues.filter((i) => i.level === "warning");
      const infos = allIssues.filter((i) => i.level === "info");

      const lines: string[] = [];
      const dirName = basePath.split(/[\\/]/).pop() || basePath;
      lines.push(`## Validation Report: ${dirName}`);
      lines.push("");

      if (errors.length > 0) {
        lines.push(`### Errors (${errors.length})`);
        for (const e of errors) lines.push(`- ${e.message}`);
        lines.push("");
      }

      if (warnings.length > 0) {
        lines.push(`### Warnings (${warnings.length})`);
        for (const w of warnings) lines.push(`- ${w.message}`);
        lines.push("");
      }

      if (infos.length > 0) {
        lines.push(`### Info (${infos.length})`);
        for (const i of infos) lines.push(`- ${i.message}`);
        lines.push("");
      }

      if (passedChecks.length > 0) {
        lines.push(`### Passed (${passedChecks.length})`);
        for (const c of passedChecks) lines.push(`- ${c}`);
        lines.push("");
      }

      if (errors.length === 0 && warnings.length === 0) {
        lines.push("All checks passed!");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
