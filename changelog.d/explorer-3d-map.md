- **docs-site: a 3D model map.** The explorer's map has a **View** control that switches
  between the flat map and a 3D one drawn from the same nodes, edges, slice and colouring
  (`#/map.html?view=3d`); click a node for the side panel and again to open its page. The 3D
  library, 3d-force-graph 1.77.0 (MIT, bundling three.js; the licences of everything it bundles
  head the file), ships with the site as `assets/3d-force-graph.min.js` and loads only when a
  reader first chooses 3D, so it works offline and no other page pays for its size. A static
  export given an `assetBase` loads it from the mirror instead. An owned
  `explorer-map.html.mustache` without the control simply has no 3D mode. Generated-output
  change — regenerate to pick it up; three-way merge preserves hand edits.
