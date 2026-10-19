import fs from "fs";
import path from "path";

export interface ZipValidationResult { ok: boolean; errors: string[]; totalUncompressed: number; entries: number; }

const MAX_ENTRIES = 10000;
const MAX_UNCOMPRESSED = 500 * 1024 * 1024;
const MAX_FILE_SIZE = 100 * 1024 * 1024;

export async function validateZip(zipPath: string): Promise<ZipValidationResult> {
  const errors: string[] = [];
  let totalUncompressed = 0;
  let entries = 0;
  const unzipper = require("unzipper");
  try {
    const directory = await unzipper.Open.file(zipPath);
    for (const file of directory.files) {
      entries++;
      if (entries > MAX_ENTRIES) { errors.push("Too many entries (zip bomb?)"); break; }
      const fileName = file.path;
      if (path.isAbsolute(fileName) || fileName.split("/").some((p: string) => p === "..")) {
        errors.push(`Unsafe path: ${fileName}`); continue;
      }
      if (file.type === "Symlink") { errors.push(`Symlink not allowed: ${fileName}`); continue; }
      const size = file.uncompressedSize || 0;
      if (size > MAX_FILE_SIZE) { errors.push(`File too large: ${fileName}`); continue; }
      totalUncompressed += size;
      if (totalUncompressed > MAX_UNCOMPRESSED) { errors.push("Uncompressed size too large (zip bomb?)"); break; }
    }
  } catch (e: any) {
    errors.push(e?.message || String(e));
  }
  return { ok: errors.length === 0, errors, totalUncompressed, entries };
}

export function safeExtractDir(base: string): string {
  const p = path.join(base, "extracted");
  fs.mkdirSync(p, { recursive: true });
  return p;
}
