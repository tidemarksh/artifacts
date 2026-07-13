import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
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

const VERSION = "1.51.0";
const SOURCE = {
  url: "https://github.com/libuv/libuv/archive/refs/tags/v1.51.0.tar.gz",
  fileName: "libuv-1.51.0.tar.gz",
  sha256: "27e55cf7083913bfb6826ca78cde9de7647cded648d35f24163f2d31bb9f51cd",
};
const PAYLOAD_ROOT = "opt/tidemark/libuv";
const EXECUTABLE = `${PAYLOAD_ROOT}/bin/uv_run_tests_a`;

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

async function downloadFile(url, path) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: ${response.status}`);
  }
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
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
  const sourceDir = resolve(workDir, "sources");
  const extractDir = resolve(workDir, "extract");
  const buildDir = resolve(workDir, "build");
  const payloadDir = resolve(workDir, "payload");
  const licensesDir = resolve(workDir, "licenses");
  const sourcePath = resolve(sourceDir, SOURCE.fileName);
  const sourceRoot = resolve(extractDir, `libuv-${VERSION}`);
  const payloadRoot = resolve(payloadDir, PAYLOAD_ROOT);
  const executablePath = resolve(payloadDir, EXECUTABLE);

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(payloadRoot, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  await downloadFile(SOURCE.url, sourcePath);
  const sourceSha256 = sha256File(sourcePath);
  if (sourceSha256 !== SOURCE.sha256) {
    throw new Error(`sha256 mismatch: expected ${SOURCE.sha256}, got ${sourceSha256}`);
  }

  run("tar", ["-xf", sourcePath, "-C", extractDir]);
  run("cmake", [
    "-S", sourceRoot,
    "-B", buildDir,
    "-G", "Ninja",
    "-DBUILD_TESTING=ON",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_SYSTEM_NAME=Linux",
    "-DCMAKE_SYSTEM_PROCESSOR=riscv64",
    "-DCMAKE_C_COMPILER=riscv64-linux-gnu-gcc",
  ]);
  run("cmake", ["--build", buildDir, "--target", "uv_run_tests_a"]);

  cpSync(sourceRoot, payloadRoot, { recursive: true });
  mkdirSync(dirname(executablePath), { recursive: true });
  copyFileSync(resolve(buildDir, "uv_run_tests_a"), executablePath);
  run("riscv64-linux-gnu-strip", ["--strip-debug", executablePath]);

  const generatedAt = new Date().toISOString();
  const licenseFiles = ["LICENSE", "LICENSE-docs", "LICENSE-extra"].map((name) => {
    const source = resolve(sourceRoot, name);
    const target = resolve(licensesDir, name);
    copyFileSync(source, target);
    return { path: name, sha256: sha256File(target) };
  });
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    files: licenseFiles,
  });

  writeJson(resolve(outDir, "manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    artifactType: "upstream-suite",
    version: VERSION,
    summary: "libuv upstream source and prebuilt riscv64 test suite.",
    payloadRoot: PAYLOAD_ROOT,
    payload: {
      sourceRoot: PAYLOAD_ROOT,
      executable: EXECUTABLE,
    },
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    sources: [
      { ...SOURCE, sha256: sourceSha256 },
      { path: "build.mjs", sha256: sha256File(resolve(recipeDir, "build.mjs")) },
    ],
  });
  writeJson(resolve(outDir, "build-info.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    builderVersion: BUILDER_VERSION,
    generatedAt,
    runner: {
      node: process.version,
      compiler: spawnSync("riscv64-linux-gnu-gcc", ["--version"], { encoding: "utf8" }).stdout.split("\n")[0],
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
