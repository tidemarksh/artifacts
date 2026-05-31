#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_INPUT = "manifests/runtime-workloads.source.json";
const DEFAULT_OUTPUT = "manifests/runtime-workloads.json";
const DEFAULT_REPOSITORY = "tidemarksh/artifacts";
const GITHUB_TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? "";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function authHeaders(extra = {}) {
  return GITHUB_TOKEN
    ? { ...extra, Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "tidemark-artifact-manifest-pin" }
    : { ...extra, "User-Agent": "tidemark-artifact-manifest-pin" };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: authHeaders({ Accept: "application/vnd.github+json" }),
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status}`);
  }
  return await response.json();
}

function releaseApiUrl(repository, tag) {
  return `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
}

function normalizeDigest(digest, label) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest ?? "");
  if (!match) {
    throw new Error(`missing sha256 digest for ${label}`);
  }
  return match[1];
}

async function releaseAssets(repository, tag) {
  const release = await fetchJson(releaseApiUrl(repository, tag));
  return new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
}

async function pinEntry(repository, entry) {
  const assets = await releaseAssets(repository, entry.releaseTag);
  const payloadAsset = assets.get(entry.asset ?? "payload.tar.zst");
  if (!payloadAsset) {
    throw new Error(`release asset not found: ${entry.releaseTag}/${entry.asset ?? "payload.tar.zst"}`);
  }
  const pinned = {
    ...entry,
    sha256: normalizeDigest(payloadAsset.digest, `${entry.releaseTag}/${payloadAsset.name}`),
  };
  const sourceManifestAsset = assets.get("source-manifest.json");
  if (sourceManifestAsset) {
    pinned.sourceManifestSha256 = normalizeDigest(
      sourceManifestAsset.digest,
      `${entry.releaseTag}/source-manifest.json`,
    );
  }
  return pinned;
}

async function main() {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const inputPath = resolve(root, readArg("--input", DEFAULT_INPUT));
  const outputPath = resolve(root, readArg("--output", DEFAULT_OUTPUT));
  const repository = readArg("--repository", DEFAULT_REPOSITORY);
  const input = readJson(inputPath);
  const output = {
    ...input,
    repository: `https://github.com/${repository}`,
    profiles: {},
  };

  for (const [profile, entries] of Object.entries(input.profiles ?? {})) {
    output.profiles[profile] = [];
    for (const entry of entries) {
      output.profiles[profile].push(await pinEntry(repository, entry));
    }
  }

  writeJson(outputPath, output);
  console.log(`wrote pinned runtime workload manifest: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
