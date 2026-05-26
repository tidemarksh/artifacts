#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILDER_VERSION, RELEASE_SCHEMA_VERSION } from "./release-contract.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing string field: ${label}`);
  }
}

function assertSchema(value, label) {
  if (value !== RELEASE_SCHEMA_VERSION) {
    throw new Error(`${label}: expected schemaVersion ${RELEASE_SCHEMA_VERSION}`);
  }
}

export function verifyReleaseContract(outDir) {
  const manifest = readJson(resolve(outDir, "manifest.json"));
  const sourceManifest = readJson(resolve(outDir, "source-manifest.json"));
  const buildInfo = readJson(resolve(outDir, "build-info.json"));

  assertSchema(manifest.schemaVersion, "manifest.json");
  assertString(manifest.artifactId, "manifest.artifactId");
  assertString(manifest.artifactType, "manifest.artifactType");
  assertString(manifest.version, "manifest.version");
  assertString(manifest.payloadRoot, "manifest.payloadRoot");

  assertSchema(sourceManifest.schemaVersion, "source-manifest.json");
  if (sourceManifest.artifactId !== manifest.artifactId) {
    throw new Error("source-manifest artifactId does not match manifest");
  }

  assertSchema(buildInfo.schemaVersion, "build-info.json");
  if (buildInfo.artifactId !== manifest.artifactId) {
    throw new Error("build-info artifactId does not match manifest");
  }
  if (buildInfo.builderVersion !== BUILDER_VERSION) {
    throw new Error(`build-info builderVersion must be ${BUILDER_VERSION}`);
  }

  const sourceManifestPath = resolve(outDir, "source-manifest.json");
  const sourceArchivePath = resolve(outDir, "sources.tar.zst");
  if (!existsSync(sourceManifestPath) && !existsSync(sourceArchivePath)) {
    throw new Error("missing source-manifest.json or sources.tar.zst");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyReleaseContract(process.argv[2] ?? "");
}
