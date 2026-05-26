# rust-riscv64-1.94.1

The upstream Rust riscv64 package is a Rust distribution installer, not a
plain final filesystem tree. This recipe uses a custom `build.mjs` to download
the pinned upstream archive, verify its checksum, run the installer into the
payload root, and include the installed license materials.

Pinned upstream source:

```text
https://static.rust-lang.org/dist/2026-03-26/rust-1.94.1-riscv64gc-unknown-linux-gnu.tar.gz
sha256 58038bca429819cc4cd52b9c364983c2e8a4c1dade8beaa0e4edd767e952ebf8
```
