# Artifact Recipes

Each artifact recipe lives in `recipes/<artifact-id>/`.

Archive recipes use a pinned `recipe.json`:

```text
recipes/<artifact-id>/
  recipe.json
```

`recipe.json` declares upstream URLs, SHA256 values, extraction rules, payload
placement, and license files. GitHub Actions downloads the upstream source,
verifies checksums, creates the payload archive, and publishes release assets.

Custom recipes may provide `build.mjs` instead:

```js
export async function build({ artifactId, recipeDir, outDir }) {
  // Write release assets into outDir.
}
```

The output directory must contain:

```text
payload.tar.zst
manifest.json
sha256sums.txt
licenses.tar.zst
build-info.json
source-manifest.json or sources.tar.zst
```

Generated release metadata must satisfy the repository release contract:

```bash
node scripts/verify-release-contract.mjs dist/<artifact-id>
```

Recipes must pin upstream versions and checksums. Debian package-set recipes
must pin each root package with `name` and `version`; dependency closure is
resolved from the Debian package index during the build and recorded in the
release manifests.

Recipes must not depend on a developer workstation cache, local paths, or
previously materialized payloads for official releases.
