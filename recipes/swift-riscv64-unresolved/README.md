# swift-riscv64-unresolved

No release recipe is defined yet.

This artifact must remain unpublished until there is a pinned redistributable
upstream source or build recipe for Linux riscv64, including checksum,
provenance, payload layout, and license materials.

Do not derive this artifact from a developer workstation cache or an existing
local materialization.

Current source check, 2026-06-08 JST:

- Official Swift Linux install page checked:
  `https://www.swift.org/install/linux/`
- Official Swiftly Linux bootstrap assets checked:
  - `https://download.swift.org/swiftly/linux/swiftly-riscv64.tar.gz`: 404
  - `https://download.swift.org/swiftly/linux/swiftly-x86_64.tar.gz`: 200
  - `https://download.swift.org/swiftly/linux/swiftly-aarch64.tar.gz`: 200
- Result: the current Swift.org Linux install flow uses the Swiftly
  architecture-specific bootstrap asset, and no `riscv64` Linux Swiftly
  bootstrap asset is published at the checked official URL.

Keep this recipe unresolved until an official redistributable Linux riscv64
toolchain source, or a reproducible build recipe with redistribution terms, can
be pinned with checksums.
