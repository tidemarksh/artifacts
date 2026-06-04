#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
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

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "";
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function stripCommandForArchitecture(architecture) {
  if (architecture === "riscv64") {
    return "riscv64-linux-gnu-strip";
  }
  return "strip";
}

function listFiles(root) {
  const result = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        result.push(path);
      }
    }
  };
  if (existsSync(root)) {
    visit(root);
  }
  return result.sort();
}

function normalizePayloadRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("stripDebug entries must be non-empty relative paths");
  }
  if (value.startsWith("/") || value.split("/").includes("..")) {
    throw new Error(`stripDebug path must stay within payload: ${value}`);
  }
  return value.split("/").filter(Boolean).join("/");
}

function resolvePayloadPath(payloadDir, relPath) {
  const normalized = normalizePayloadRelativePath(relPath);
  const path = resolve(payloadDir, normalized);
  const root = `${resolve(payloadDir)}/`;
  if (!path.startsWith(root)) {
    throw new Error(`payload path escapes payload root: ${relPath}`);
  }
  return { normalized, path };
}

function listTopLevelFiles(root) {
  return readdirSync(root)
    .map((name) => resolve(root, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function tarZstd(sourceDir, outPath) {
  run("tar", ["--zstd", "-cf", outPath, "-C", sourceDir, "."]);
}

function parsePackagesFile(text) {
  const records = new Map();
  for (const block of text.split(/\n{2,}/)) {
    const record = {};
    let currentKey = null;
    for (const line of block.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      if (line.startsWith(" ") && currentKey) {
        record[currentKey] += `\n${line.slice(1)}`;
        continue;
      }
      const colon = line.indexOf(":");
      if (colon < 0) {
        continue;
      }
      currentKey = line.slice(0, colon);
      record[currentKey] = line.slice(colon + 1).trimStart();
    }
    if (record.Package && record.Filename) {
      records.set(record.Package, record);
    }
  }
  return records;
}

function dependencyName(value) {
  const match = /^([A-Za-z0-9+.-]+)(?::[A-Za-z0-9-]+)?/.exec(value.trim());
  return match?.[1] ?? null;
}

function parseProvidedNames(value) {
  if (!value) {
    return [];
  }
  return value.split(",").map((part) => dependencyName(part)).filter(Boolean);
}

function buildPackageIndex(records) {
  const provides = new Map();
  for (const [name, record] of records) {
    for (const provided of parseProvidedNames(record.Provides)) {
      const providers = provides.get(provided) ?? [];
      providers.push(name);
      provides.set(provided, providers);
    }
  }
  for (const providers of provides.values()) {
    providers.sort();
  }
  return { packages: records, provides };
}

function splitDependencyGroups(value) {
  if (!value) {
    return [];
  }
  return value.split(",").map((group) => group.split("|").map((part) => part.trim()).filter(Boolean));
}

function resolveDependencyGroup(group, packageIndex) {
  for (const candidate of group) {
    const name = dependencyName(candidate);
    if (name && packageIndex.packages.has(name)) {
      return name;
    }
  }
  for (const candidate of group) {
    const name = dependencyName(candidate);
    const provider = name ? packageIndex.provides.get(name)?.[0] : null;
    if (provider) {
      return provider;
    }
  }
  throw new Error(`no installable dependency alternative found: ${group.join(" | ")}`);
}

function packageDependencies(record, packageIndex) {
  const deps = [];
  for (const field of ["Pre-Depends", "Depends"]) {
    for (const group of splitDependencyGroups(record[field])) {
      const dep = resolveDependencyGroup(group, packageIndex);
      if (dep) {
        deps.push(dep);
      }
    }
  }
  return deps;
}

function resolvePackageClosure(packageNames, packageIndex) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(name) {
    if (visited.has(name) || visiting.has(name)) {
      return;
    }
    const record = packageIndex.packages.get(name);
    if (!record) {
      throw new Error(`package not found in Debian index: ${name}`);
    }
    visiting.add(name);
    for (const dep of packageDependencies(record, packageIndex)) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(record);
  }

  for (const name of packageNames) {
    visit(name);
  }
  return ordered;
}

function normalizeRootPackage(rootPackage) {
  if (typeof rootPackage === "string") {
    return { name: rootPackage };
  }
  return rootPackage;
}

function rootPackageNames(rootPackages) {
  return rootPackages.map((rootPackage) => normalizeRootPackage(rootPackage).name);
}

function assertPinnedRootVersions(rootPackages, packageIndex) {
  for (const rootPackage of rootPackages.map(normalizeRootPackage)) {
    if (!rootPackage.version) {
      throw new Error(`root package ${rootPackage.name} must pin version`);
    }
    const record = packageIndex.packages.get(rootPackage.name);
    if (!record) {
      throw new Error(`package not found in Debian index: ${rootPackage.name}`);
    }
    if (record.Version !== rootPackage.version) {
      throw new Error(
        `root package ${rootPackage.name} version mismatch: expected ${rootPackage.version}, got ${record.Version}`,
      );
    }
  }
}

async function readDebianPackageIndex({ mirror, suite, architecture, components }, workDir) {
  const merged = new Map();
  const indexes = [];
  for (const component of components) {
    const url = `${mirror}/dists/${suite}/${component}/binary-${architecture}/Packages.xz`;
    const compressed = await fetchBytes(url);
    const xzPath = resolve(workDir, `${component}-Packages.xz`);
    writeFileSync(xzPath, compressed);
    const text = run("xz", ["-dc", xzPath]).toString("utf8");
    for (const [name, record] of parsePackagesFile(text)) {
      merged.set(name, { ...record, Component: component });
    }
    indexes.push({ url, component, sha256: sha256Bytes(compressed), size: compressed.length });
  }
  return { packageIndex: buildPackageIndex(merged), indexes };
}

function arMembers(bytes) {
  if (bytes.subarray(0, 8).toString("utf8") !== "!<arch>\n") {
    throw new Error("invalid deb archive header");
  }
  const members = [];
  let offset = 8;
  while (offset + 60 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString("utf8").trim().replace(/\/$/, "");
    const size = Number.parseInt(header.subarray(48, 58).toString("utf8").trim(), 10);
    const dataStart = offset + 60;
    const dataEnd = dataStart + size;
    members.push({ name, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd + (size % 2);
  }
  return members;
}

function extractDeb(debPath, payloadDir, workDir, packageName) {
  const dataMember = arMembers(readFileSync(debPath)).find((member) => member.name.startsWith("data.tar"));
  if (!dataMember) {
    throw new Error(`data.tar member not found in ${debPath}`);
  }
  const dataPath = resolve(workDir, `${packageName}-${dataMember.name}`);
  writeFileSync(dataPath, dataMember.data);
  run("tar", ["-xf", dataPath, "-C", payloadDir]);
}

function stripPayloadDebugFiles(payloadDir, debian) {
  const stripDebug = debian.stripDebug ?? [];
  if (stripDebug.length === 0) {
    return [];
  }
  const command = stripCommandForArchitecture(debian.architecture);
  const records = [];
  for (const relPath of stripDebug) {
    const { normalized, path } = resolvePayloadPath(payloadDir, relPath);
    if (!existsSync(path)) {
      throw new Error(`stripDebug payload file not found: ${normalized}`);
    }
    const beforeSize = statSync(path).size;
    const beforeSha256 = sha256File(path);
    run(command, ["--strip-debug", path]);
    records.push({
      path: normalized,
      tool: command,
      action: "strip-debug",
      sizeBefore: beforeSize,
      sizeAfter: statSync(path).size,
      sha256Before: beforeSha256,
      sha256After: sha256File(path),
    });
  }
  return records;
}

async function downloadDebs(records, mirror, sourceDir) {
  const downloads = [];
  mkdirSync(sourceDir, { recursive: true });
  for (const record of records) {
    const url = `${mirror}/${record.Filename}`;
    const fileName = basename(record.Filename);
    const path = resolve(sourceDir, fileName);
    const bytes = await fetchBytes(url);
    writeFileSync(path, bytes);
    const sha256 = sha256File(path);
    if (sha256 !== record.SHA256) {
      throw new Error(`sha256 mismatch for ${record.Package}: expected ${record.SHA256}, got ${sha256}`);
    }
    downloads.push({ record, url, fileName, path, sha256, size: bytes.length });
  }
  return downloads;
}

function collectDebianCopyrights(payloadDir, licensesDir) {
  const docDir = resolve(payloadDir, "usr/share/doc");
  const copied = [];
  if (!existsSync(docDir)) {
    return copied;
  }
  for (const path of listFiles(docDir)) {
    if (basename(path) !== "copyright") {
      continue;
    }
    const rel = relative(docDir, path);
    const target = resolve(licensesDir, "debian-copyright", rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
    copied.push({ path: `debian-copyright/${rel}`, sha256: sha256File(path) });
  }
  return copied;
}

export async function buildDebianPackageRecipe({ artifactId, recipeDir, outDir }) {
  const recipe = readJson(resolve(recipeDir, "recipe.json"));
  if (recipe.artifactId !== artifactId) {
    throw new Error(`recipe artifactId mismatch: ${recipe.artifactId}`);
  }
  const debian = recipe.debian;
  const workDir = resolve(outDir, ".work");
  const sourceDir = resolve(workDir, "sources");
  const payloadDir = resolve(workDir, "payload");
  const licensesDir = resolve(workDir, "licenses");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(payloadDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  const { packageIndex, indexes } = await readDebianPackageIndex(debian, workDir);
  assertPinnedRootVersions(debian.rootPackages, packageIndex);
  const records = resolvePackageClosure(rootPackageNames(debian.rootPackages), packageIndex);
  const downloads = await downloadDebs(records, debian.mirror, sourceDir);
  for (const { record, path } of downloads) {
    extractDeb(path, payloadDir, workDir, record.Package);
  }
  const payloadTransforms = stripPayloadDebugFiles(payloadDir, debian);
  const licenseFiles = collectDebianCopyrights(payloadDir, licensesDir);
  const generatedAt = new Date().toISOString();
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    source: `${debian.mirror} ${debian.suite} ${debian.components.join(",")} ${debian.architecture}`,
    files: licenseFiles,
  });

  const packages = records.map((record) => ({
    name: record.Package,
    version: record.Version,
    architecture: record.Architecture,
    filename: record.Filename,
    sha256: record.SHA256,
    size: Number(record.Size),
    source: record.Source ?? record.Package,
  }));

  writeJson(resolve(outDir, "manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    artifactType: recipe.type,
    version: recipe.version,
    summary: recipe.summary,
    payloadRoot: "/",
    debian,
    payloadTransforms,
    packageCount: packages.length,
    packages,
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    packageIndexes: indexes,
    debs: downloads.map(({ record, url, fileName, sha256, size }) => ({
      package: record.Package,
      version: record.Version,
      url,
      fileName,
      sha256,
      size,
    })),
    payloadTransforms,
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

  const releaseFiles = listTopLevelFiles(outDir)
    .filter((path) => basename(path) !== "sha256sums.txt");
  const sums = releaseFiles
    .map((path) => `${sha256File(path)}  ${relative(outDir, path)}`)
    .join("\n");
  writeFileSync(resolve(outDir, "sha256sums.txt"), `${sums}\n`);
}
