- **codegen-ts: an entity named after a reserved word gets a queries module that parses.** An
  entity called `Case` (or `Default`, `Class`, …) wrote `const [case] = await db.select()…` in
  its `<Entity>.queries.ts`, which is a syntax error; the row variable now takes the `Row` suffix
  (`caseRow`) that a collection-name clash already took.
