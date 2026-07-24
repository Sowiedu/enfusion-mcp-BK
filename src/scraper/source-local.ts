import AdmZip from "adm-zip";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../utils/logger.js";

export interface HtmlEntry {
  filename: string;
  html: string;
}

const ZIP_FILES = {
  enfusion: "EnfusionScriptAPIPublic.zip",
  arma: "ArmaReforgerScriptAPIPublic.zip",
} as const;

const ZIP_PREFIXES = {
  enfusion: "EnfusionScriptAPIPublic/",
  arma: "ArmaReforgerScriptAPIPublic/",
} as const;

export function getZipPath(
  workbenchPath: string,
  source: "enfusion" | "arma"
): string {
  return resolve(workbenchPath, "Workbench", "docs", ZIP_FILES[source]);
}

/**
 * Iterate HTML files from a local Workbench docs zip.
 * Yields {filename, html} for each HTML file matching the given pattern.
 */
export function* readHtmlFromZip(
  workbenchPath: string,
  source: "enfusion" | "arma",
  pattern?: RegExp
): Generator<HtmlEntry> {
  const zipPath = getZipPath(workbenchPath, source);

  if (!existsSync(zipPath)) {
    logger.error(`Zip file not found: ${zipPath}`);
    return;
  }

  logger.info(`Reading from ${zipPath}`);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const prefix = ZIP_PREFIXES[source];

  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.endsWith(".html")) continue;

    // Strip the prefix directory. Newer (1.7-era) API zips nest all pages
    // under an extra "html/" folder (e.g. ArmaReforgerScriptAPIPublic/html/
    // interfaceX.html), whereas older exports placed them directly under the
    // top-level prefix. Strip the optional "html/" segment so the yielded
    // filename stays bare (interfaceX.html) for both layouts.
    let filename = entry.entryName.startsWith(prefix)
      ? entry.entryName.slice(prefix.length)
      : entry.entryName;
    if (filename.startsWith("html/")) filename = filename.slice("html/".length);

    // Apply pattern filter if provided
    if (pattern && !pattern.test(filename)) continue;

    const html = entry.getData().toString("utf-8");
    count++;
    yield { filename, html };
  }

  logger.info(`Read ${count} HTML files from ${ZIP_FILES[source]}`);
}

/**
 * Read a specific file from the zip by filename.
 */
export function readFileFromZip(
  workbenchPath: string,
  source: "enfusion" | "arma",
  filename: string
): string | null {
  const zipPath = getZipPath(workbenchPath, source);
  if (!existsSync(zipPath)) return null;

  const zip = new AdmZip(zipPath);
  // Try the flat layout first, then the newer "html/" nested layout.
  const entry =
    zip.getEntry(ZIP_PREFIXES[source] + filename) ??
    zip.getEntry(ZIP_PREFIXES[source] + "html/" + filename);

  if (!entry) return null;
  return entry.getData().toString("utf-8");
}
