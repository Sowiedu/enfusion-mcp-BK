import { openSync, readSync, closeSync, readdirSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { parsePakIndex, type PakIndex, type PakDirEntry, type PakFileEntry } from "./reader.js";
import { logger } from "../utils/logger.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface VfsEntry {
  name: string;
  isDirectory: boolean;
  /** Decompressed size for files, 0 for directories */
  size: number;
}

interface FileRef {
  pakPath: string;
  dataStart: number;
  entry: PakFileEntry;
}

// ── PakVirtualFS ─────────────────────────────────────────────────────────────

/**
 * Virtual filesystem that merges all .pak files from the game's addons/ directory
 * (and any extra mod/addon pak roots) into a single unified file tree. Supports
 * directory listing, file existence checks, and on-demand file reading with
 * automatic zlib decompression.
 *
 * Instances are built lazily and cached per (game path + mod roots) combination
 * for the session lifetime.
 */
export class PakVirtualFS {
  /** Cache keyed by the composite of game path + mod roots so distinct root
   *  sets never alias the same instance. */
  private static cache = new Map<string, PakVirtualFS>();

  /** Flat lookup: normalized virtual path → file reference */
  private fileIndex = new Map<string, FileRef>();
  /** Merged directory tree for browsing */
  private root: PakDirEntry = { kind: "dir", name: "", children: new Map() };

  /** Clear all cached VFS instances, forcing a fresh rebuild on next get(). */
  static invalidate(): void {
    PakVirtualFS.cache.clear();
  }

  /** Build the cache key for a given game path and ordered set of mod roots. */
  private static cacheKey(gamePath: string, modPaths: string[]): string {
    // Canonicalize each root (absolute form, no trailing separator, casefolded
    // for Windows's case-insensitive filesystems) so equivalent spellings of
    // the same directory share one instance. Order is preserved — it defines
    // collision precedence. NUL never appears in file paths, so it cannot
    // collide the way a space separator could (Windows paths contain spaces).
    return [gamePath, ...modPaths]
      .map((p) => resolve(p).replace(/[\\/]+$/, "").toLowerCase())
      .join("\u0000");
  }

  /**
   * Get or create the cached VFS for the given game path plus optional extra
   * mod/addon pak roots. The base game's addons/ folder is scanned first, then
   * each mod root in order; on a virtual-path collision the first-indexed file
   * wins, so the base game always takes precedence.
   *
   * Backwards compatible: called with a single argument it behaves exactly as
   * before (base game only). Returns null if no .pak files are found anywhere.
   */
  static get(gamePath: string, modPaths: string[] = []): PakVirtualFS | null {
    const key = PakVirtualFS.cacheKey(gamePath, modPaths);
    const cached = PakVirtualFS.cache.get(key);
    if (cached) return cached;

    // Base game first (its paks win on collisions), then each mod root in order.
    // Order is preserved across roots — do NOT globally sort, or a mod pak could
    // shadow a base game pak alphabetically.
    const pakFiles: string[] = [...scanRootForPaks(join(gamePath, "addons"))];
    for (const modRoot of modPaths) {
      pakFiles.push(...scanRootForPaks(modRoot));
    }

    if (pakFiles.length === 0) return null;

    const vfs = new PakVirtualFS(pakFiles);
    PakVirtualFS.cache.set(key, vfs);
    return vfs;
  }

  private constructor(pakFiles: string[]) {
    const start = Date.now();
    let totalFiles = 0;

    for (const pakPath of pakFiles) {
      try {
        const index = parsePakIndex(pakPath);
        const count = this.mergeTree(this.root, index.root, index, "");
        totalFiles += count;
      } catch (e) {
        logger.warn(`Failed to parse pak file ${pakPath}: ${e}`);
        // Continue with other paks — graceful degradation
      }
    }

    const elapsed = Date.now() - start;
    logger.info(
      `PAK VFS initialized: ${pakFiles.length} pak files, ${totalFiles} entries, ` +
      `${this.fileIndex.size} files indexed in ${elapsed}ms`
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * List entries in a virtual directory.
   * Path uses forward slashes, no leading slash (e.g., "Prefabs/Weapons").
   * Empty string = root.
   */
  listDir(virtualPath: string): VfsEntry[] {
    const dir = this.resolveDir(virtualPath);
    if (!dir) return [];

    const entries: VfsEntry[] = [];
    for (const [name, child] of dir.children) {
      if (child.kind === "dir") {
        entries.push({ name, isDirectory: true, size: 0 });
      } else {
        entries.push({ name, isDirectory: false, size: child.decompressedLen });
      }
    }
    return entries;
  }

  /** Check if a path exists (file or directory). */
  exists(virtualPath: string): boolean {
    const norm = normalizePath(virtualPath);
    if (norm === "") return true; // root always exists
    return this.fileIndex.has(norm) || this.resolveDir(norm) !== null;
  }

  /**
   * Read a file's raw bytes from the pak archive.
   * Opens the .pak, seeks to the correct offset, reads, decompresses if needed.
   */
  readFile(virtualPath: string): Buffer {
    const norm = normalizePath(virtualPath);
    const ref = this.fileIndex.get(norm);
    if (!ref) {
      throw new Error(`File not found in pak: ${virtualPath}`);
    }

    const { pakPath, entry } = ref;
    const readLen = entry.compressed ? entry.compressedLen : entry.decompressedLen;

    const fd = openSync(pakPath, "r");
    try {
      const buf = Buffer.alloc(readLen);
      // entry.offset is an absolute position within the .pak file
      const position = entry.offset;
      const bytesRead = readSync(fd, buf, 0, readLen, position);
      if (bytesRead < readLen) {
        throw new Error(
          `Truncated read from pak: expected ${readLen} bytes, got ${bytesRead}`
        );
      }

      if (entry.compressed) {
        // zlib stream with header, not raw deflate
        return inflateSync(buf);
      }
      return buf;
    } finally {
      closeSync(fd);
    }
  }

  /** Read a file as UTF-8 text. */
  readTextFile(virtualPath: string): string {
    return this.readFile(virtualPath).toString("utf-8");
  }

  /** Get decompressed file size without reading/inflating. Returns -1 if not found. */
  fileSize(virtualPath: string): number {
    const norm = normalizePath(virtualPath);
    const ref = this.fileIndex.get(norm);
    return ref ? ref.entry.decompressedLen : -1;
  }

  /** Get all file paths in the VFS (for building the asset search index). */
  allFilePaths(): string[] {
    return Array.from(this.fileIndex.keys());
  }

  /** Get the number of indexed files. */
  get fileCount(): number {
    return this.fileIndex.size;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Merge a parsed pak tree into the unified directory tree.
   * Returns the number of file entries added.
   */
  private mergeTree(
    target: PakDirEntry,
    source: PakDirEntry,
    index: PakIndex,
    pathPrefix: string
  ): number {
    let count = 0;

    for (const [name, child] of source.children) {
      const childPath = pathPrefix ? `${pathPrefix}/${name}` : name;

      if (child.kind === "dir") {
        // Merge directories: create in target if missing, then recurse
        let targetChild = target.children.get(name);
        if (!targetChild || targetChild.kind !== "dir") {
          targetChild = { kind: "dir", name, children: new Map() };
          target.children.set(name, targetChild);
        }
        count += this.mergeTree(targetChild, child, index, childPath);
      } else {
        // File: add to target and flat index (first pak wins)
        const norm = normalizePath(childPath);
        if (!this.fileIndex.has(norm)) {
          target.children.set(name, child);
          this.fileIndex.set(norm, {
            pakPath: index.pakPath,
            dataStart: index.dataStart,
            entry: child,
          });
          count++;
        }
      }
    }

    return count;
  }

  /** Resolve a virtual path to a directory entry, or null if not found. */
  private resolveDir(virtualPath: string): PakDirEntry | null {
    const norm = normalizePath(virtualPath);
    if (norm === "") return this.root;

    const parts = norm.split("/");
    let current: PakDirEntry = this.root;

    for (const part of parts) {
      const child = current.children.get(part);
      if (!child || child.kind !== "dir") return null;
      current = child;
    }

    return current;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Scan a single pak root for .pak files: the root directory itself plus one
 * level deep (e.g. addons/data/, or addons/<AddonName_GUID>/data.pak). Results
 * are sorted for deterministic, reproducible order within the root. Returns an
 * empty array if the root does not exist or cannot be read.
 */
function scanRootForPaks(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];

  let topEntries;
  try {
    topEntries = readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const pakFiles: string[] = topEntries
    .filter((e) => e.isFile() && extname(e.name).toLowerCase() === ".pak")
    .map((e) => join(rootPath, e.name));

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    try {
      const subEntries = readdirSync(join(rootPath, entry.name), { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isFile() && extname(sub.name).toLowerCase() === ".pak") {
          pakFiles.push(join(rootPath, entry.name, sub.name));
        }
      }
    } catch {
      // Skip unreadable subdirectories
    }
  }

  pakFiles.sort(); // deterministic order — first pak alphabetically wins within a root
  return pakFiles;
}

/** Normalize a virtual path: trim slashes, convert backslashes, lowercase. */
function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}
