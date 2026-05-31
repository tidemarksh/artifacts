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
import {
  BUILDER_VERSION,
  RELEASE_SCHEMA_VERSION,
} from "../../scripts/release-contract.mjs";

const VERSION = "2026-05";
const SOURCE_FILE = "src/exec-capture-helper.go";
const PAYLOAD_ROOT = "opt/tidemark/go-exec-capture-helper";
const EXECUTABLE = `${PAYLOAD_ROOT}/exec-capture-helper.riscv64`;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
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

function tarZstd(sourceDir, outPath) {
  run("tar", ["--zstd", "-cf", outPath, "-C", sourceDir, "."]);
}

export async function build({ artifactId, recipeDir, outDir }) {
  const workDir = resolve(outDir, ".work");
  const payloadDir = resolve(workDir, "payload");
  const licensesDir = resolve(workDir, "licenses");
  const sourcePath = resolve(recipeDir, SOURCE_FILE);
  const executablePath = resolve(payloadDir, EXECUTABLE);

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dirname(executablePath), { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  if (!existsSync(sourcePath)) {
    throw new Error(`missing source file: ${sourcePath}`);
  }

  run("go", [
    "build",
    "-trimpath",
    "-ldflags=-buildid=",
    "-o",
    executablePath,
    sourcePath,
  ], {
    env: {
      ...process.env,
      GOOS: "linux",
      GOARCH: "riscv64",
      CGO_ENABLED: "0",
    },
  });

  const generatedAt = new Date().toISOString();
  const licensePath = resolve(recipeDir, "../../LICENSE");
  const licenseFiles = [];
  if (existsSync(licensePath)) {
    const target = resolve(licensesDir, "LICENSE");
    copyFileSync(licensePath, target);
    licenseFiles.push({ path: "LICENSE", sha256: sha256File(target) });
  }
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    files: licenseFiles,
  });

  writeJson(resolve(outDir, "manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    artifactType: "go-helper",
    version: VERSION,
    summary: "RISC-V Linux helper binary used by Tidemark runtime Go exec capture tests.",
    payloadRoot: PAYLOAD_ROOT,
    payload: {
      executable: EXECUTABLE,
    },
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    sources: [
      {
        path: SOURCE_FILE,
        sha256: sha256File(sourcePath),
      },
    ],
  });
  writeJson(resolve(outDir, "build-info.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    builderVersion: BUILDER_VERSION,
    generatedAt,
    runner: {
      node: process.version,
      go: spawnSync("go", ["version"], { encoding: "utf8" }).stdout.trim(),
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

  if (!statSync(executablePath).isFile()) {
    throw new Error(`missing built executable: ${executablePath}`);
  }
}
