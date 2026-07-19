import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { buildIndex } from "../../src/tools/asset-search.js";

/**
 * Build a minimal synthetic .pak file using the real on-disk format: entry
 * offsets are ABSOLUTE byte positions within the .pak seeded at the DATA payload
 * start, and compressed payloads are zlib streams (deflateSync, header present).
 * This mirrors the builder in vfs.test.ts / reader.test.ts.
 */
function buildTestPak(files: Array<{ path: string; content: string; compress: boolean }>): Buffer {
  interface TreeFile { name: string; offset: number; compressedLen: number; decompressedLen: number; compressed: boolean }
  interface TreeDir { name: string; children: Map<string, TreeDir | TreeFile> }

  const dataChunks: Buffer[] = [];
  // FORM(4)+totalLen(4)+PAC1(4)+HEAD(4)+headLen(4)+headPayload(0x1c)+DATA(4)+dataLen(4) = 56.
  const DATA_PAYLOAD_START = 4 + 4 + 4 + 4 + 4 + 0x1c + 4 + 4;
  let dataOffset = DATA_PAYLOAD_START;
  const root: TreeDir = { name: "", children: new Map() };

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf-8");
    const stored = file.compress ? deflateSync(raw) : raw;

    const parts = file.path.split("/");
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let child = dir.children.get(part);
      if (!child || !("children" in child)) {
        child = { name: part, children: new Map() };
        dir.children.set(part, child);
      }
      dir = child as TreeDir;
    }

    dir.children.set(fileName, {
      name: fileName, offset: dataOffset,
      compressedLen: stored.length, decompressedLen: raw.length,
      compressed: file.compress,
    });
    dataChunks.push(stored);
    dataOffset += stored.length;
  }

  function serializeEntry(entry: TreeDir | TreeFile): Buffer {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const parts: Buffer[] = [];
    const header = Buffer.alloc(2);

    if ("children" in entry) {
      header.writeUInt8(0, 0);
      header.writeUInt8(nameBuf.length, 1);
      parts.push(header, nameBuf);
      const countBuf = Buffer.alloc(4);
      countBuf.writeUInt32LE(entry.children.size, 0);
      parts.push(countBuf);
      for (const child of entry.children.values()) {
        parts.push(serializeEntry(child));
      }
    } else {
      header.writeUInt8(1, 0);
      header.writeUInt8(nameBuf.length, 1);
      parts.push(header, nameBuf);
      const meta = Buffer.alloc(24);
      meta.writeUInt32LE(entry.offset, 0);
      meta.writeUInt32LE(entry.compressedLen, 4);
      meta.writeUInt32LE(entry.decompressedLen, 8);
      meta.writeUInt32LE(0, 12);
      meta.writeUInt16LE(0, 16);
      meta.writeUInt8(entry.compressed ? 1 : 0, 18);
      meta.writeUInt8(entry.compressed ? 6 : 0, 19);
      meta.writeUInt32LE(0, 20); // timestamp
      parts.push(meta);
    }
    return Buffer.concat(parts);
  }

  const fileTreeBuf = serializeEntry(root);
  const dataPayload = Buffer.concat(dataChunks);
  const headLen = 0x1c;
  const headPayload = Buffer.alloc(headLen);

  const totalPayload = 4 + 8 + headLen + 8 + dataPayload.length + 8 + fileTreeBuf.length;
  const buf = Buffer.alloc(8 + totalPayload);
  let pos = 0;

  buf.write("FORM", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(totalPayload, pos); pos += 4;
  buf.write("PAC1", pos, 4, "ascii"); pos += 4;
  buf.write("HEAD", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(headLen, pos); pos += 4;
  headPayload.copy(buf, pos); pos += headLen;
  buf.write("DATA", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(dataPayload.length, pos); pos += 4;
  dataPayload.copy(buf, pos); pos += dataPayload.length;
  buf.write("FILE", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(fileTreeBuf.length, pos); pos += 4;
  fileTreeBuf.copy(buf, pos);

  return buf;
}

// ── Fixture layout ─────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "enfusion-mcp-vfs-multiroot-" + process.pid);
const GAME_DIR = join(TEST_DIR, "game");
const GAME_ADDONS = join(GAME_DIR, "addons");
// Mod root holds addons one level deep (<AddonName_GUID>/data.pak), like the
// real "My Games/ArmaReforger/addons" layout.
const MOD_ROOT = join(TEST_DIR, "mods");
const MOD_ADDON = join(MOD_ROOT, "MyMod_1234ABCD");

function resetCache(): void {
  (PakVirtualFS as unknown as { cache: Map<string, unknown> }).cache.clear();
}

beforeAll(() => {
  mkdirSync(GAME_ADDONS, { recursive: true });
  mkdirSync(MOD_ADDON, { recursive: true });

  // Base game pak: owns Prefabs/shared.et with content "BASE".
  const basePak = buildTestPak([
    { path: "Prefabs/shared.et", content: "BASE", compress: false },
    { path: "Scripts/base.c", content: "class Base {}", compress: false },
  ]);
  writeFileSync(join(GAME_ADDONS, "data.pak"), basePak);

  // Mod pak (one level deep): also declares Prefabs/shared.et (content "MOD"),
  // plus a mod-only file. Base must win the shared path.
  const modPak = buildTestPak([
    { path: "Prefabs/shared.et", content: "MOD", compress: true },
    { path: "Prefabs/modonly.et", content: "MODONLY", compress: true },
  ]);
  writeFileSync(join(MOD_ADDON, "data.pak"), modPak);

  resetCache();
});

afterAll(() => {
  resetCache();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("PakVirtualFS multi-root", () => {
  it("merges mod roots on top of the base game", () => {
    const vfs = PakVirtualFS.get(GAME_DIR, [MOD_ROOT])!;
    expect(vfs).not.toBeNull();
    // shared.et (both), modonly.et (mod), base.c (base) = 3 unique paths.
    expect(vfs.exists("Prefabs/modonly.et")).toBe(true);
    expect(vfs.exists("Scripts/base.c")).toBe(true);
    expect(vfs.fileCount).toBe(3);
  });

  it("gives the base game precedence on virtual-path collisions", () => {
    const vfs = PakVirtualFS.get(GAME_DIR, [MOD_ROOT])!;
    // Base is scanned first, so its "BASE" content wins over the mod's "MOD".
    expect(vfs.readTextFile("Prefabs/shared.et")).toBe("BASE");
  });

  it("keys the cache on the mod-root set (no aliasing)", () => {
    const baseOnly = PakVirtualFS.get(GAME_DIR);
    const withMod = PakVirtualFS.get(GAME_DIR, [MOD_ROOT]);
    // Different root sets must not return the same cached instance.
    expect(baseOnly).not.toBe(withMod);
    // Base-only sees only the base game's 2 files.
    expect(baseOnly!.fileCount).toBe(2);
    // Same args return the same cached instance.
    expect(PakVirtualFS.get(GAME_DIR, [MOD_ROOT])).toBe(withMod);
  });

  it("behaves identically to the legacy single-arg form", () => {
    const a = PakVirtualFS.get(GAME_DIR);
    const b = PakVirtualFS.get(GAME_DIR, []);
    expect(a).toBe(b);
    expect(a!.fileCount).toBe(2);
  });
});

// ── Entity-catalog GUID extraction from inside paks ─────────────────────────────

const CATALOG_DIR = join(TEST_DIR, "catalog-game");
const CATALOG_ADDONS = join(CATALOG_DIR, "addons");
const LOOSE_BASE = join(TEST_DIR, "catalog-loose");

describe("entity-catalog GUID extraction from paks", () => {
  beforeAll(() => {
    mkdirSync(CATALOG_ADDONS, { recursive: true });
    // Loose base dir with its own entity catalog. It re-declares Group_A with a
    // DIFFERENT guid so we can prove loose wins over the pak entry.
    const looseCatDir = join(LOOSE_BASE, "Configs", "EntityCatalog");
    mkdirSync(looseCatDir, { recursive: true });
    writeFileSync(
      join(looseCatDir, "Loose.conf"),
      'm_Entries { m_sEntityPrefab "{AAAAAAAAAAAAAAAA}Prefabs/Groups/Group_A.et" }',
      "utf-8"
    );

    // Pak containing an entity-catalog .conf (compressed) with two GUID pairs.
    const pak = buildTestPak([
      {
        path: "Configs/EntityCatalog/Groups.conf",
        content:
          'm_Entries {\n' +
          '  m_sEntityPrefab "{1111111111111111}Prefabs/Groups/Group_A.et"\n' +
          '  m_sEntityPrefab "{2222222222222222}Prefabs/Groups/Group_B.et"\n' +
          '}',
        compress: true,
      },
      // A non-catalog .conf must be ignored by the catalog walk.
      { path: "Configs/game.conf", content: "GameConfig {}", compress: false },
      // The referenced prefabs must exist as .et entries for GUIDs to attach.
      { path: "Prefabs/Groups/Group_A.et", content: "GenericEntity {}", compress: false },
      { path: "Prefabs/Groups/Group_B.et", content: "GenericEntity {}", compress: false },
    ]);
    writeFileSync(join(CATALOG_ADDONS, "data.pak"), pak);

    resetCache();
  });

  it("extracts GUID/path pairs from pak-internal catalogs, loose winning on conflict", () => {
    const entries = buildIndex(LOOSE_BASE, CATALOG_DIR);
    const byPath = new Map(entries.map((e) => [e.path.toLowerCase(), e]));

    // Group_A exists in both catalogs -> loose GUID (AAAA...) wins.
    const groupA = byPath.get("prefabs/groups/group_a.et");
    expect(groupA?.guid).toBe("AAAAAAAAAAAAAAAA");

    // Group_B only appears in the pak catalog -> its pak GUID is picked up.
    const groupB = byPath.get("prefabs/groups/group_b.et");
    expect(groupB?.guid).toBe("2222222222222222");
  });
});
