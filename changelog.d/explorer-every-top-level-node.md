- **Every top-level node gets an explorer page.** The site wrote pages only for objects and
  templates, so a requirement claiming a node of another type, such as an application's
  `capability.module`, failed the site's own link check. Every other top-level type now gets a
  generic page (`explorer-node.html.mustache`, which `meta eject docs-site` copies): its
  attributes, linked where they name a node, its members, the requirements claiming it, what
  references it and what was generated from it. Package pages and search list these nodes too.
