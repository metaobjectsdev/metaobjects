- **Repository: Bun 1.3.14 is the declared package manager.** The root `package.json` now
  declares `bun@1.3.14`, the version every workflow pins, in place of 1.3.8 (which segfaults on
  exit). Rebuilding or checking the explorer app (`server/typescript/packages/docs-site/scripts/build-app.ts`,
  the `explorer app copies` gate and its unit test) requires that exact version, because the
  committed bundle is minified and minified output follows the Bun version; any other Bun stops
  with an error naming 1.3.14.
