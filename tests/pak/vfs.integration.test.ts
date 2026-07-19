import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PakVirtualFS } from "../../src/pak/vfs.js";

// Validate pak reading against a real game install on this machine. The install
// directory is resolved from ENFUSION_GAME_PATH, falling back to the default
// Steam location. When neither the directory nor its addons/ subdirectory
// exists, the whole suite is skipped (never failed) so the test is portable.
const GAME_PATH =
  process.env.ENFUSION_GAME_PATH ??
  "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger";

const HAS_GAME = existsSync(GAME_PATH) && existsSync(join(GAME_PATH, "addons"));

// Roughly how many entries to sample. The sample is a deterministic lexicographic
// stride over all entry paths so the run is fast and reproducible.
const SAMPLE_TARGET = 200;

describe.skipIf(!HAS_GAME)("PakVirtualFS against a real game install", () => {
  let vfs: PakVirtualFS | null = null;

  beforeAll(() => {
    vfs = PakVirtualFS.get(GAME_PATH);
  });

  it("builds a VFS with indexed files over the install", () => {
    expect(vfs).not.toBeNull();
    expect(vfs!.fileCount).toBeGreaterThan(0);
  });

  it(
    "reads a deterministic sample and matches recorded decompressed sizes",
    () => {
      expect(vfs).not.toBeNull();

      // Sort all entry paths lexicographically, then take every Nth so the
      // sample is deterministic and bounded to ~SAMPLE_TARGET entries.
      const paths = vfs!.allFilePaths().slice().sort();
      expect(paths.length).toBeGreaterThan(0);

      const stride = Math.max(1, Math.ceil(paths.length / SAMPLE_TARGET));
      const sample: string[] = [];
      for (let i = 0; i < paths.length; i += stride) {
        sample.push(paths[i]);
      }
      expect(sample.length).toBeGreaterThan(0);

      for (const path of sample) {
        const expectedSize = vfs!.fileSize(path);
        expect(expectedSize).toBeGreaterThanOrEqual(0);

        let buf: Buffer | undefined;
        // readFile must not throw for any sampled entry.
        expect(() => {
          buf = vfs!.readFile(path);
        }, `readFile threw for ${path}`).not.toThrow();

        // The returned (decompressed) buffer length must exactly equal the
        // size recorded in the pak index for that entry.
        expect(buf, `no buffer returned for ${path}`).toBeInstanceOf(Buffer);
        expect(buf!.length, `size mismatch for ${path}`).toBe(expectedSize);
      }
    },
    30_000
  );
});
