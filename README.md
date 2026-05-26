# Tidemark Artifacts

This repository owns reproducible recipes, release manifests, and GitHub
Actions workflows for Tidemark test workload artifacts.

Generated payloads are not stored in git. Git stores only recipes, scripts,
manifests, and release automation. GitHub Actions builds each artifact and
publishes release assets.

## Boundary

The source code, recipes, scripts, and workflow files in this repository are
licensed as stated by this repository license.

Release payloads are separate redistributable artifact bundles. Each payload
keeps its own upstream licenses, notices, source provenance, package metadata,
and checksum manifest. A payload is not relicensed as Apache-2.0 by being
published here.

## Release Unit

Artifacts should be released by binary, runtime, suite, or toolchain identity,
not by a consuming repository.

Examples:

```text
busybox-riscv64-1.36.1
go-riscv64-1.26.1
node-riscv64-debian-trixie
glibc-riscv64-debian-trixie-2.42
python-riscv64-3.12.13
ruby-riscv64-3.3.8-debian-sid
php-riscv64-8.4.16-debian-sid
lua-riscv64-5.4.8-debian-sid
perl-riscv64-5.40.1-debian-sid
r-riscv64-4.5.3-debian-sid
elixir-erlang-riscv64-1.18.3-27.3
java-temurin-riscv64-25.0.2
rust-riscv64-1.94.1
c-toolchain-riscv64-gcc16
cpp-toolchain-riscv64-gcc16
haskell-riscv64-ghc-9.10.3
devtools-riscv64-2026-05
apt-riscv64-debian-trixie
libuv-suite-1.51.0
```

Consumer repositories should lock the exact release asset URL, version, size,
and SHA256 they need.

## Release Asset Contract

Each artifact release must include:

```text
payload.tar.zst
manifest.json
sha256sums.txt
licenses.tar.zst
build-info.json
source-manifest.json or sources.tar.zst
```

For Debian-derived artifacts, the manifest must include package names,
versions, architecture, source packages, `.deb` SHA256 values, and copied
`/usr/share/doc/*/copyright` files.

## Local Development

Build one artifact locally:

```bash
node scripts/build-artifact.mjs --artifact-id <id> --out dist/<id>
```

Verify the output layout:

```bash
node scripts/verify-release-layout.mjs dist/<id>
```

Official release assets should be built by GitHub Actions, not uploaded from a
developer workstation.

