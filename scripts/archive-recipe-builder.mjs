#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { BUILDER_VERSION, RELEASE_SCHEMA_VERSION } from "./release-contract.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function listFiles(root) {
  const result = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        result.push(path);
      }
    }
  };
  visit(root);
  return result.sort();
}

async function downloadFile(url, path) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  writeFileSync(path, body);
}

function tarZstd(sourceDir, outPath) {
  execFileSync("tar", ["--zstd", "-cf", outPath, "-C", sourceDir, "."], {
    stdio: "inherit",
  });
}

function extractTarArchive({ archivePath, targetDir, stripComponents }) {
  mkdirSync(targetDir, { recursive: true });
  const args = ["-xf", archivePath, "-C", targetDir];
  if (stripComponents > 0) {
    args.push(`--strip-components=${stripComponents}`);
  }
  execFileSync("tar", args, { stdio: "inherit" });
}

function copyLicenseFiles({ payloadDir, licensesDir, licenseFiles }) {
  const copied = [];
  for (const item of licenseFiles ?? []) {
    const from = resolve(payloadDir, item.path);
    if (!existsSync(from)) {
      throw new Error(`missing license file declared by recipe: ${item.path}`);
    }
    const to = resolve(licensesDir, item.path);
    mkdirSync(dirname(to), { recursive: true });
    const stat = statSync(from);
    if (stat.isDirectory()) {
      cpSync(from, to, { recursive: true });
      copied.push({ path: item.path, type: "directory" });
    } else if (stat.isFile()) {
      copyFileSync(from, to);
      copied.push({ path: item.path, type: "file", sha256: sha256File(from) });
    } else {
      throw new Error(`unsupported license path type: ${item.path}`);
    }
  }
  return copied;
}

export async function buildArchiveRecipe({ artifactId, recipeDir, outDir }) {
  const recipePath = resolve(recipeDir, "recipe.json");
  const recipe = readJson(recipePath);
  if (recipe.artifactId !== artifactId) {
    throw new Error(`recipe artifactId mismatch: ${recipe.artifactId}`);
  }
  if (recipe.type !== "archive") {
    throw new Error(`unsupported recipe type: ${recipe.type}`);
  }

  const workDir = resolve(outDir, ".work");
  const sourceDir = resolve(workDir, "sources");
  const payloadDir = resolve(workDir, "payload");
  const licensesDir = resolve(workDir, "licenses");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(payloadDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  const sourceRecords = [];
  for (const source of recipe.sources) {
    const fileName = source.fileName ?? basename(new URL(source.url).pathname);
    const path = resolve(sourceDir, fileName);
    await downloadFile(source.url, path);
    const actualSha256 = sha256File(path);
    if (actualSha256 !== source.sha256) {
      throw new Error(
        `sha256 mismatch for ${source.url}: expected ${source.sha256}, got ${actualSha256}`,
      );
    }
    sourceRecords.push({ ...source, fileName, sha256: actualSha256 });
  }

  const archiveSource = sourceRecords.find(
    (source) => source.fileName === recipe.archive.source,
  );
  if (!archiveSource) {
    throw new Error(`archive source not found: ${recipe.archive.source}`);
  }

  const targetDir = resolve(payloadDir, recipe.archive.target ?? ".");
  extractTarArchive({
    archivePath: resolve(sourceDir, archiveSource.fileName),
    targetDir,
    stripComponents: recipe.archive.stripComponents ?? 0,
  });

  const copiedLicenses = copyLicenseFiles({
    payloadDir,
    licensesDir,
    licenseFiles: recipe.licenseFiles,
  });
  const generatedAt = new Date().toISOString();
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    files: copiedLicenses,
  });

  writeJson(resolve(outDir, "manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    artifactType: recipe.type,
    version: recipe.version,
    summary: recipe.summary,
    payloadRoot: recipe.payload?.root ?? recipe.archive.target ?? ".",
    payload: recipe.payload,
    archive: recipe.archive,
    sourceCount: sourceRecords.length,
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    sources: sourceRecords,
  });
  writeJson(resolve(outDir, "build-info.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    builderVersion: BUILDER_VERSION,
    generatedAt,
    runner: {
      node: process.version,
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubSha: process.env.GITHUB_SHA ?? null,
      githubRef: process.env.GITHUB_REF ?? null,
    },
  });

  tarZstd(payloadDir, resolve(outDir, "payload.tar.zst"));
  tarZstd(licensesDir, resolve(outDir, "licenses.tar.zst"));

  const releaseFiles = listFiles(outDir)
    .filter((path) => !path.includes(`${workDir}/`))
    .filter((path) => basename(path) !== "sha256sums.txt")
    .filter((path) => statSync(path).isFile());
  const sums = releaseFiles
    .map((path) => `${sha256File(path)}  ${relative(outDir, path)}`)
    .join("\n");
  writeFileSync(resolve(outDir, "sha256sums.txt"), `${sums}\n`);
}
