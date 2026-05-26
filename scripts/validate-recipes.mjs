#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const recipesDir = resolve(root, "recipes");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing string field: ${label}`);
  }
}

function validateRecipe(recipe, path) {
  assertString(recipe.artifactId, `${path}: artifactId`);
  assertString(recipe.type, `${path}: type`);
  assertString(recipe.version, `${path}: version`);
  if (recipe.type !== "archive" && recipe.type !== "debian-package-set") {
    throw new Error(`${path}: unsupported type ${recipe.type}`);
  }
  if (recipe.type === "debian-package-set") {
    assertString(recipe.debian?.mirror, `${path}: debian.mirror`);
    assertString(recipe.debian?.suite, `${path}: debian.suite`);
    assertString(recipe.debian?.architecture, `${path}: debian.architecture`);
    if (!Array.isArray(recipe.debian.components) || recipe.debian.components.length === 0) {
      throw new Error(`${path}: debian.components must be a non-empty array`);
    }
    if (!Array.isArray(recipe.debian.rootPackages) || recipe.debian.rootPackages.length === 0) {
      throw new Error(`${path}: debian.rootPackages must be a non-empty array`);
    }
    for (const rootPackage of recipe.debian.rootPackages) {
      if (typeof rootPackage === "string") {
        throw new Error(`${path}: debian.rootPackages entries must pin name and version`);
      }
      assertString(rootPackage?.name, `${path}: debian.rootPackages.name`);
      assertString(rootPackage?.version, `${path}: debian.rootPackages.version`);
    }
    if (recipe.debian.mirror.includes("/home/") || recipe.debian.mirror.startsWith("file:")) {
      throw new Error(`${path}: local Debian mirror references are not allowed`);
    }
    return;
  }
  if (!Array.isArray(recipe.sources) || recipe.sources.length === 0) {
    throw new Error(`${path}: sources must be a non-empty array`);
  }
  for (const source of recipe.sources) {
    assertString(source.url, `${path}: source.url`);
    assertString(source.sha256, `${path}: source.sha256`);
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error(`${path}: invalid source sha256`);
    }
    if (source.url.includes("/home/") || source.url.startsWith("file:")) {
      throw new Error(`${path}: local source references are not allowed`);
    }
  }
  assertString(recipe.archive?.source, `${path}: archive.source`);
  assertString(recipe.archive?.target, `${path}: archive.target`);
  if (!Number.isInteger(recipe.archive.stripComponents)) {
    throw new Error(`${path}: archive.stripComponents must be an integer`);
  }
}

let count = 0;
for (const name of readdirSync(recipesDir).sort()) {
  const dir = join(recipesDir, name);
  if (!statSync(dir).isDirectory()) {
    continue;
  }
  const path = join(dir, "recipe.json");
  if (!existsSync(path)) {
    continue;
  }
  const recipe = readJson(path);
  if (recipe.artifactId !== name) {
    throw new Error(`${path}: artifactId must match directory name`);
  }
  validateRecipe(recipe, path);
  count += 1;
}

console.log(`validated ${count} recipe(s)`);
