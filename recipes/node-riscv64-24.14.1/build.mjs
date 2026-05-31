import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import {
  BUILDER_VERSION,
  RELEASE_SCHEMA_VERSION,
} from "../../scripts/release-contract.mjs";

const VERSION = "24.14.1";
const SOURCE_URL = `https://nodejs.org/dist/v${VERSION}/node-v${VERSION}.tar.xz`;
const SOURCE_SHA256 = "7822507713f202cf2a551899d250259643f477b671706db421a6fb55c4aa0991";
const SOURCE_FILE = `node-v${VERSION}.tar.xz`;
const PAYLOAD_ROOT = ".";
const NODE_PATH = "usr/bin/node";
const CONFIGURE_ARGS = [
  "--cross-compiling",
  "--dest-cpu=riscv64",
  "--dest-os=linux",
  "--openssl-no-asm",
  "--without-npm",
  "--without-corepack",
  "--without-node-code-cache",
];

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
  const body = Buffer.from(await response.arrayBuffer());
  writeFileSync(path, body);
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

export async function build({ artifactId, recipeDir, outDir }) {
  if (artifactId !== "node-riscv64-24.14.1") {
    throw new Error(`recipe artifactId mismatch: ${artifactId}`);
  }

  const workDir = resolve(outDir, ".work");
  const sourceDir = resolve(workDir, "sources");
  const buildDir = resolve(workDir, "build");
  const payloadDir = resolve(workDir, "payload");
  const licensesDir = resolve(workDir, "licenses");
  const sourcePath = resolve(sourceDir, SOURCE_FILE);
  const nodePath = resolve(payloadDir, NODE_PATH);

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(dirname(nodePath), { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  await downloadFile(SOURCE_URL, sourcePath);
  const sourceSha256 = sha256File(sourcePath);
  if (sourceSha256 !== SOURCE_SHA256) {
    throw new Error(`sha256 mismatch for ${SOURCE_URL}: expected ${SOURCE_SHA256}, got ${sourceSha256}`);
  }

  run("tar", ["-xf", sourcePath, "-C", buildDir, "--strip-components=1"]);

  const buildEnv = {
    ...process.env,
    CC_host: process.env.CC_host ?? "gcc",
    CXX_host: process.env.CXX_host ?? "g++",
    CC_target: process.env.CC_target ?? "riscv64-linux-gnu-gcc",
    CXX_target: process.env.CXX_target ?? "riscv64-linux-gnu-g++",
    LINK_target: process.env.LINK_target ?? "riscv64-linux-gnu-g++",
  };
  run("./configure", CONFIGURE_ARGS, { cwd: buildDir, env: buildEnv });
  run("make", [`-j${process.env.NODE_BUILD_JOBS ?? "2"}`, "node"], {
    cwd: buildDir,
    env: buildEnv,
  });

  copyFileSync(resolve(buildDir, "out/Release/node"), nodePath);
  copyFileSync(resolve(buildDir, "LICENSE"), resolve(licensesDir, "NODE-LICENSE"));

  const generatedAt = new Date().toISOString();
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    files: [
      {
        path: "NODE-LICENSE",
        sha256: sha256File(resolve(licensesDir, "NODE-LICENSE")),
      },
    ],
  });

  writeJson(resolve(outDir, "manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    artifactType: "node-source-build",
    version: VERSION,
    summary: "Source-built riscv64 Node.js binary used by Tidemark runtime Node workload tests.",
    payloadRoot: PAYLOAD_ROOT,
    payload: {
      executable: NODE_PATH,
    },
    build: {
      configureArgs: CONFIGURE_ARGS,
      target: "linux-riscv64",
    },
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    sources: [
      {
        name: "node",
        url: SOURCE_URL,
        fileName: SOURCE_FILE,
        sha256: sourceSha256,
      },
      {
        path: "build.mjs",
        sha256: sha256File(resolve(recipeDir, "build.mjs")),
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
      make: spawnSync("make", ["--version"], { encoding: "utf8" }).stdout.split("\n")[0],
      ccTarget: buildEnv.CC_target,
      cxxTarget: buildEnv.CXX_target,
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

  if (!statSync(nodePath).isFile()) {
    throw new Error(`missing built node: ${nodePath}`);
  }
}
