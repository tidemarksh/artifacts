import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
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

const SOURCE = {
  url: "https://static.rust-lang.org/dist/2026-03-26/rust-1.94.1-riscv64gc-unknown-linux-gnu.tar.gz",
  fileName: "rust-1.94.1-riscv64gc-unknown-linux-gnu.tar.gz",
  sha256: "58038bca429819cc4cd52b9c364983c2e8a4c1dade8beaa0e4edd767e952ebf8",
};

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

function copyLicensePath({ payloadDir, licensesDir, path }) {
  const from = resolve(payloadDir, path);
  if (!existsSync(from)) {
    return null;
  }
  const to = resolve(licensesDir, path);
  mkdirSync(dirname(to), { recursive: true });
  const stat = statSync(from);
  if (stat.isDirectory()) {
    cpSync(from, to, { recursive: true });
    return { path, type: "directory" };
  }
  copyFileSync(from, to);
  return { path, type: "file", sha256: sha256File(from) };
}

export async function build({ artifactId, outDir }) {
  const workDir = resolve(outDir, ".work");
  const sourceDir = resolve(workDir, "sources");
  const extractDir = resolve(workDir, "extract");
  const payloadDir = resolve(workDir, "payload");
  const licensesDir = resolve(workDir, "licenses");
  const installPrefix = resolve(payloadDir, "opt/tidemark/rust");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(payloadDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  const sourcePath = resolve(sourceDir, SOURCE.fileName);
  await downloadFile(SOURCE.url, sourcePath);
  const actualSha256 = sha256File(sourcePath);
  if (actualSha256 !== SOURCE.sha256) {
    throw new Error(`sha256 mismatch: expected ${SOURCE.sha256}, got ${actualSha256}`);
  }

  run("tar", ["-xf", sourcePath, "-C", extractDir]);
  const installerDir = resolve(
    extractDir,
    "rust-1.94.1-riscv64gc-unknown-linux-gnu",
  );
  run("sh", [
    "install.sh",
    `--prefix=${installPrefix}`,
    "--disable-ldconfig",
    "--verbose",
  ], { cwd: installerDir });

  const generatedAt = new Date().toISOString();
  const licenseFiles = [
    "opt/tidemark/rust/share/doc/rust",
    "opt/tidemark/rust/share/doc/cargo",
    "opt/tidemark/rust/share/doc/clippy",
    "opt/tidemark/rust/share/doc/rustfmt",
    "opt/tidemark/rust/share/doc/rust-analyzer",
  ]
    .map((path) => copyLicensePath({ payloadDir, licensesDir, path }))
    .filter(Boolean);
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    files: licenseFiles,
  });

  writeJson(resolve(outDir, "manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    artifactType: "rust-installer",
    version: "1.94.1",
    summary: "Official Rust riscv64gc unknown-linux-gnu toolchain install.",
    payloadRoot: "opt/tidemark/rust",
    payload: {
      root: "opt/tidemark/rust",
      executables: [
        "opt/tidemark/rust/bin/rustc",
        "opt/tidemark/rust/bin/cargo",
        "opt/tidemark/rust/bin/rustfmt",
      ],
    },
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    sources: [
      {
        ...SOURCE,
        sha256: actualSha256,
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
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubSha: process.env.GITHUB_SHA ?? null,
      githubRef: process.env.GITHUB_REF ?? null,
    },
  });

  run("tar", ["--zstd", "-cf", resolve(outDir, "payload.tar.zst"), "-C", payloadDir, "."]);
  run("tar", ["--zstd", "-cf", resolve(outDir, "licenses.tar.zst"), "-C", licensesDir, "."]);

  const releaseFiles = listFiles(outDir)
    .filter((path) => !path.includes(`${workDir}/`))
    .filter((path) => basename(path) !== "sha256sums.txt");
  const sums = releaseFiles
    .map((path) => `${sha256File(path)}  ${relative(outDir, path)}`)
    .join("\n");
  writeFileSync(resolve(outDir, "sha256sums.txt"), `${sums}\n`);
}
