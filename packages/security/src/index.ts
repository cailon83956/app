import fs from "fs";
import path from "path";
import { createReadStream } from "fs";
import zlib from "zlib";

export interface ZipValidationResult { ok: boolean; errors: string[]; totalUncompressed: number; entries: number; }

const MAX_ENTRIES = 10000;
const MAX_UNCOMPRESSED = 500 * 1024 * 1024; // 500MB
const MAX_FILE_SIZE = 100 * 1024 * 1024;

export async function validateZip(zipPath: string): Promise<ZipValidationResult> {
  const errors: string[] = [];
  let totalUncompressed = 0;
  let entries = 0;
  // Use unzipper to inspect
  const unzipper = require("unzipper");
  return new Promise((resolve) => {
    const stream = createReadStream(zipPath).pipe(unzipper.Parse({ forceStream: true }));
    stream.on("entry", (entry: any) => {
      entries++;
      if (entries > MAX_ENTRIES) { errors.push("Too many entries (zip bomb?)"); entry.autodrain(); return; }
      const fileName = entry.path;
      // path traversal
      if (path.isAbsolute(fileName) || fileName.includes("..")) {
        errors.push(`Unsafe path: ${fileName}`);
        entry.autodrain();
        return;
      }
      // symlink
      if (entry.type === "Symlink") {
        errors.push(`Symlink not allowed: ${fileName}`);
        entry.autodrain();
        return;
      }
      const size = entry.vars?.uncompressedSize || 0;
      if (size > MAX_FILE_SIZE) { errors.push(`File too large: ${fileName}`); entry.autodrain(); return; }
      totalUncompressed += size;
      if (totalUncompressed > MAX_UNCOMPRESSED) { errors.push("Uncompressed size too large (zip bomb?)"); entry.autodrain(); return; }
      entry.autodrain();
    });
    stream.on("close", () => resolve({ ok: errors.length === 0, errors, totalUncompressed, entries }));
    stream.on("error", (e: any) => { errors.push(e.message); resolve({ ok: false, errors, totalUncompressed, entries }); });
  });
}

export function safeExtractDir(base: string): string {
  const p = path.join(base, "extracted");
  fs.mkdirSync(p, { recursive: true });
  return p;
}
