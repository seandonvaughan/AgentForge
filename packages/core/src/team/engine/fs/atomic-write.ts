import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function safeTempNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function makeAtomicTempPath(filePath: string, prefix = "agentforge"): string {
  const dir = dirname(filePath);
  const base = safeTempNameSegment(basename(filePath));
  const suffix = randomBytes(8).toString("hex");
  return join(dir, `.${base}.${prefix}-${process.pid}-${suffix}.tmp`);
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = makeAtomicTempPath(filePath);
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
