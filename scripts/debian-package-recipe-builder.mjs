#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  if (existsSync(root)) {
    visit(root);
  }
  return result.sort();
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
  const records = resolvePackageClosure(debian.rootPackages, packageIndex);
  const downloads = await downloadDebs(records, debian.mirror, sourceDir);
  for (const { record, path } of downloads) {
    extractDeb(path, payloadDir, workDir, record.Package);
  }
  const licenseFiles = collectDebianCopyrights(payloadDir, licensesDir);
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    artifactId,
    generatedAt: new Date().toISOString(),
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
    artifactId,
    type: recipe.type,
    version: recipe.version,
    summary: recipe.summary,
    debian,
    packageCount: packages.length,
    packages,
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    artifactId,
    generatedAt: new Date().toISOString(),
    packageIndexes: indexes,
    debs: downloads.map(({ record, url, fileName, sha256, size }) => ({
      package: record.Package,
      version: record.Version,
      url,
      fileName,
      sha256,
      size,
    })),
  });
  writeJson(resolve(outDir, "build-info.json"), {
    artifactId,
    generatedAt: new Date().toISOString(),
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
    .filter((path) => basename(path) !== "sha256sums.txt");
  const sums = releaseFiles
    .map((path) => `${sha256File(path)}  ${relative(outDir, path)}`)
    .join("\n");
  writeFileSync(resolve(outDir, "sha256sums.txt"), `${sums}\n`);
}
