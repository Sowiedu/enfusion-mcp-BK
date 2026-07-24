import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { logger } from "../utils/logger.js";
import type {
  ClassInfo,
  GroupInfo,
  HierarchyNode,
  WikiPage,
} from "../index/types.js";

export interface ScrapeOutput {
  enfusionClasses: ClassInfo[];
  armaClasses: ClassInfo[];
  hierarchy: HierarchyNode[];
  groups: GroupInfo[];
  wikiPages: WikiPage[];
}

function writeJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  logger.info(`Wrote ${filePath}`);
}

/** Read an existing JSON array file, or return [] if missing/corrupt. */
function readJsonArray<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T[];
  } catch {
    return [];
  }
}

/**
 * Write `classes` unless empty, in which case preserve the existing file.
 * A source zip that is missing on this machine (e.g. the Enfusion engine API)
 * yields zero classes; overwriting with [] would destroy good cached data.
 */
function writeClassesPreserving(filePath: string, classes: ClassInfo[]): void {
  if (classes.length === 0) {
    logger.warn(
      `No classes scraped for ${filePath} — preserving existing file (source zip likely missing)`
    );
    return;
  }
  writeJson(filePath, classes);
}

/** Merge new entries over existing ones by `name`, preserving names not re-scraped. */
function mergeByName<T extends { name: string }>(existing: T[], scraped: T[]): T[] {
  const scrapedNames = new Set(scraped.map((e) => e.name));
  const preserved = existing.filter((e) => !scrapedNames.has(e.name));
  return [...preserved, ...scraped];
}

export function writeOutput(dataDir: string, output: ScrapeOutput): void {
  const apiDir = resolve(dataDir, "api");
  const wikiDir = resolve(dataDir, "wiki");

  const enfusionPath = resolve(apiDir, "enfusion-classes.json");
  const armaPath = resolve(apiDir, "arma-classes.json");
  const hierarchyPath = resolve(apiDir, "hierarchy.json");
  const groupsPath = resolve(apiDir, "groups.json");

  writeClassesPreserving(enfusionPath, output.enfusionClasses);
  writeClassesPreserving(armaPath, output.armaClasses);

  // hierarchy.json / groups.json combine both sources and carry no per-entry
  // source tag, so a missing source can't be cleanly subtracted. Merge by name:
  // refresh re-scraped entries, preserve the rest (e.g. Enfusion-only groups).
  writeJson(
    hierarchyPath,
    mergeByName(readJsonArray<HierarchyNode>(hierarchyPath), output.hierarchy)
  );
  writeJson(
    groupsPath,
    mergeByName(readJsonArray<GroupInfo>(groupsPath), output.groups)
  );
  // Merge wiki pages: preserve existing BI wiki pages, replace only Doxygen-sourced pages
  const pagesPath = resolve(wikiDir, "pages.json");
  let existingPages: WikiPage[] = [];
  if (existsSync(pagesPath)) {
    try {
      existingPages = JSON.parse(readFileSync(pagesPath, "utf-8")) as WikiPage[];
    } catch {
      // Corrupted file — will be overwritten
    }
  }
  // Keep pages from sources NOT in the current scrape output
  const scrapedSources = new Set(output.wikiPages.map((p) => p.source));
  const preservedPages = existingPages.filter((p) => !scrapedSources.has(p.source));
  const mergedPages = [...preservedPages, ...output.wikiPages];
  writeJson(pagesPath, mergedPages);

  logger.info(
    `Scrape complete: ${output.enfusionClasses.length} enfusion classes, ${output.armaClasses.length} arma classes, ${output.hierarchy.length} hierarchy nodes, ${output.groups.length} groups, ${mergedPages.length} wiki pages (${output.wikiPages.length} from Doxygen + ${preservedPages.length} preserved)`
  );
}
