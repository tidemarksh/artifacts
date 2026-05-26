#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseLayout } from "./verify-release-layout.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] ?? "";
}

const artifactId = readArg("--artifact-id");
const outArg = readArg("--out");

if (!/^[a-z0-9][a-z0-9._-]*$/.test(artifactId)) {
  throw new Error("missing or invalid --artifact-id");
}

const root = resolve(new URL("..", import.meta.url).pathname);
const recipeDir = resolve(root, "recipes", artifactId);
const buildModulePath = resolve(recipeDir, "build.mjs");
const outDir = resolve(outArg || `dist/${artifactId}`);

if (!existsSync(buildModulePath)) {
  throw new Error(`missing recipe build module: ${buildModulePath}`);
}

mkdirSync(outDir, { recursive: true });

const recipe = await import(pathToFileURL(buildModulePath).href);
if (typeof recipe.build !== "function") {
  throw new Error(`recipe does not export build(): ${buildModulePath}`);
}

await recipe.build({ artifactId, recipeDir, outDir });
verifyReleaseLayout(outDir);

