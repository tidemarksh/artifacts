# Artifact Recipes

Each artifact recipe lives in `recipes/<artifact-id>/`.

Required files:

```text
recipes/<artifact-id>/
  README.md
  build.mjs
```

`build.mjs` must export:

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

Recipes must pin upstream versions and checksums. They must not depend on a
developer workstation cache for official releases.

