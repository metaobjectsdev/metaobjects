- **The model explorer builds on a project with its own top-level vocabulary.** Two top-level
  nodes of different types sharing a package and a name (an entity `Lead` and a page `Lead`)
  made `buildExplorer` throw `two nodes share the id`. The object now keeps the plain
  `<package>::<name>` id and each other node adds its type, `acme::crm::Lead[page.list]`, as a
  nested sibling already did; a model with no such collision gets the same ids as before. A
  requirement whose id took a qualifier still takes its ledger row.
