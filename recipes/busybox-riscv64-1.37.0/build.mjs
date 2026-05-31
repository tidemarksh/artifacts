import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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

const VERSION = "1.37.0";
const PAYLOAD_ROOT = ".";
const BUSYBOX_PATH = "busybox";

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

function removeContainer(containerName) {
  spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
}

export async function build({ artifactId, recipeDir, outDir }) {
  const workDir = resolve(outDir, ".work");
  const payloadDir = resolve(workDir, "payload");
  const licensesDir = resolve(workDir, "licenses");
  const busyboxPath = resolve(payloadDir, BUSYBOX_PATH);
  const dockerfilePath = resolve(recipeDir, "Dockerfile");
  const tag = `tidemark-artifact-${artifactId}:${process.pid}`;
  const containerName = `tidemark-artifact-${artifactId}-${process.pid}`;

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dirname(busyboxPath), { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  run("docker", [
    "build",
    "--target",
    "builder",
    "-t",
    tag,
    "-f",
    dockerfilePath,
    recipeDir,
  ]);

  removeContainer(containerName);
  try {
    run("docker", ["create", "--name", containerName, tag, "/bin/true"]);
    run("docker", [
      "cp",
      `${containerName}:/build/busybox-1.37.0/busybox`,
      busyboxPath,
    ]);
    run("docker", [
      "cp",
      `${containerName}:/build/busybox-1.37.0/LICENSE`,
      resolve(licensesDir, "BUSYBOX-LICENSE"),
    ]);
  } finally {
    removeContainer(containerName);
  }

  const generatedAt = new Date().toISOString();
  writeJson(resolve(licensesDir, "LICENSE-MANIFEST.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    files: [
      {
        path: "BUSYBOX-LICENSE",
        sha256: sha256File(resolve(licensesDir, "BUSYBOX-LICENSE")),
      },
    ],
  });

  writeJson(resolve(outDir, "manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    artifactType: "busybox",
    version: VERSION,
    summary: "Static riscv64 BusyBox binary used by Tidemark runtime shell workload tests.",
    payloadRoot: PAYLOAD_ROOT,
    payload: {
      executable: BUSYBOX_PATH,
    },
  });
  writeJson(resolve(outDir, "source-manifest.json"), {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    artifactId,
    generatedAt,
    sources: [
      {
        name: "ubuntu",
        reference: "ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b",
      },
      {
        name: "musl-cross-make",
        repository: "https://github.com/richfelker/musl-cross-make.git",
        commit: "e5147dde912478dd32ad42a25003e82d4f5733aa",
      },
      {
        name: "linux-headers",
        url: "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.6.68.tar.xz",
        sha256: "283ff410e3f352ceed161ae30c0020301326059db03e86efcb384d46ac5840e2",
      },
      {
        name: "busybox",
        url: "https://busybox.net/downloads/busybox-1.37.0.tar.bz2",
        sha256: "3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4",
      },
      {
        path: "Dockerfile",
        sha256: sha256File(dockerfilePath),
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
      docker: spawnSync("docker", ["--version"], { encoding: "utf8" }).stdout.trim(),
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

  if (!statSync(busyboxPath).isFile()) {
    throw new Error(`missing built busybox: ${busyboxPath}`);
  }
}
