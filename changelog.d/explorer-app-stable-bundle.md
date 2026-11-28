- **The explorer app's bundle builds the same bytes every time.** `explorer-app/assets/explorer-app.js`
  is now minified for whitespace and syntax only, and keeps its identifiers' names. Bun's choice of
  short names was not stable between builds of unchanged sources, so the check that the committed
  bundle is what the sources build failed at random. The bundle grows from about 95 KB to about
  120 KB. Every port's copy is refreshed, so the docs site's `assets/explorer-app.js` changes and
  nothing else does. Generated-output change — regenerate to pick it up; three-way merge preserves
  hand edits.
