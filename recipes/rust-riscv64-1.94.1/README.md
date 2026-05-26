# rust-riscv64-1.94.1

The upstream Rust riscv64 package is a Rust distribution installer, not a
plain final filesystem tree. This artifact should be implemented as a custom
recipe that downloads the pinned upstream archive, verifies its checksum, runs
the installer into the payload root, and includes the installed license
materials.

Pinned upstream source:

```text
https://static.rust-lang.org/dist/2026-03-26/rust-1.94.1-riscv64gc-unknown-linux-gnu.tar.gz
sha256 58038bca429819cc4cd52b9c364983c2e8a4c1dade8beaa0e4edd767e952ebf8
```
