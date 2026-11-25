- **The agent pages sort in code-unit order.** `agent/requirements.md` (its node index and
  statements) and `agent/schema.md` (its tables and views) sorted names with `localeCompare`,
  whose collation differs between machines and could not be matched exactly by another port.
  They now sort by code unit, the order the docs-page corpus pins in every port, and Python's
  pages drop the collation emulation they carried to match. A model whose names differ only in
  case or punctuation may see those rows reorder once. Python's `agent/schema.md` now also
  carries the `meta migrate` wording only for a project that set `migrate.dialect`, as the
  TypeScript page does. Generated-output change — regenerate to pick it up; three-way merge
  preserves hand edits.
