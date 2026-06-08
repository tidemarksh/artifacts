# dotnet-riscv64-unresolved

No release recipe is defined yet.

This artifact must remain unpublished until there is a pinned redistributable
upstream source or build recipe for Linux riscv64, including checksum,
provenance, payload layout, and license materials.

Do not derive this artifact from a developer workstation cache or an existing
local materialization.

Current source check, 2026-06-08 JST:

- Official .NET release index:
  `https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json`
- Checked official `releases.json` metadata for channels 11.0 preview, 10.0,
  9.0, and 8.0.
- Result: no `linux-riscv64` / `riscv64` runtime or SDK file entries were
  present in those official metadata files.

Keep this recipe unresolved until an official redistributable Linux riscv64
runtime or SDK source, or a reproducible build recipe with redistribution
terms, can be pinned with checksums.
