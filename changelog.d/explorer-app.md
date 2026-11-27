- **docs-site: the model explorer is one browser app.** `docsSiteFile()` now writes the
  explorer as a few files (a shell, the app, the theme, Cytoscape and three data files:
  `explorer.json`, `explorer-model.js`, `explorer-stamp.js`) in place of a page per screen.
  The app draws every page when it is visited, with the same page code and templates, so each
  page is byte-for-byte the one the static site wrote. It runs from `file://` with no server,
  addresses each page as `index.html#/<page>`, and follows the model while it is open: it polls
  the stamp file about once a second and draws the current page again when `meta gen` rewrites
  the model. Cytoscape 3.30.2 (MIT) ships with the site, so the graphs draw offline and the
  CDN notice is gone. `docsSiteFile({ output: "static" })` (and `generateExplorerSite({ output:
  "static" })`) writes the earlier page-per-screen site from the same code, for publishing
  without scripts or for Pagefind; `assetBase` now applies to that export only, which given one
  loads Cytoscape from it and ships no copy. The app's files live once at `explorer-app/` and
  in every port's package (`scripts/sync-explorer-app.sh`, gated by `explorer app copies`);
  the other ports' docs-site generators are still to write them. Generated-output change: the
  next `meta gen` replaces the explorer's pages with the app's files, and `meta verify
  --codegen` holds the new files to the model as before.
