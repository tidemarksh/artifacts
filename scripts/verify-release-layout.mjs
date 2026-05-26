#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const requiredFiles = [
  "payload.tar.zst",
  "manifest.json",
  "sha256sums.txt",
  "licenses.tar.zst",
  "build-info.json",
];

export function verifyReleaseLayout(outDir) {
  for (const name of requiredFiles) {
    const path = resolve(outDir, name);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`missing required release asset: ${path}`);
    }
  }

  const hasSourceManifest = existsSync(resolve(outDir, "source-manifest.json"));
  const hasSourceArchive = existsSync(resolve(outDir, "sources.tar.zst"));
  if (!hasSourceManifest && !hasSourceArchive) {
    throw new Error("missing source-manifest.json or sources.tar.zst");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyReleaseLayout(process.argv[2] ?? "");
}

