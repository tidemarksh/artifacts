# Release Guide

Artifact releases are produced by the `build artifact` GitHub Actions workflow.
Do not upload release payloads from a developer workstation.

## Tag Names

Use the artifact identity as the release tag. Do not append a date, build
number, or other release suffix to the tag.

Examples:

```text
go-riscv64-1.26.1
zig-riscv64-0.15.2
java-temurin-riscv64-25.0.2
libuv-suite-1.51.0
node-sysroot-riscv64-debian-trixie
apt-riscv64-debian-trixie
lua-riscv64-5.4.8-debian-sid
```

## Dispatch

Run the workflow with:

```bash
gh api -X POST repos/tidemarksh/artifacts/actions/workflows/build-artifact.yml/dispatches \
  -f ref=main \
  -f 'inputs[artifact_id]=node-sysroot-riscv64-debian-trixie' \
  -f 'inputs[release_tag]=node-sysroot-riscv64-debian-trixie' \
  -F 'inputs[publish]=true'
```

The workflow validates recipes, builds the requested artifact, uploads the
workflow artifact, and publishes the release assets when `publish` is true.

## Required Assets

Each release must include:

```text
payload.tar.zst
manifest.json
sha256sums.txt
licenses.tar.zst
build-info.json
source-manifest.json or sources.tar.zst
```

Verify local output with:

```bash
node scripts/verify-release-layout.mjs dist/<artifact-id>
node scripts/verify-release-contract.mjs dist/<artifact-id>
```
