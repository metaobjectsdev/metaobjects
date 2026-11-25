- **The generator-authoring surface is named and promised.** Each port names the modules you write
  your own generator against, in four roles: the generator interface, the model walk, the code
  writer and the naming helpers. They are listed in a new `surface` block of
  `fixtures/generator-registry-conformance/registry.json`. That surface is versioned with the port's
  codegen package under the compatibility policy; the rest of the engine is internal. A generator
  will declare what it provides in one place instead of flags named after packaged generators, and
  reference templates that `meta eject` copies stay your own code, never surface. Decision record:
  ADR-0034 Amendment 12, ADR-0035 Amendment 7, ADR-0065 Amendment 5. TypeScript pins the
  surface's exported names in `codegen-ts/test/authoring-surface.snapshot.json`, and the engine
  entry (`@metaobjectsdev/codegen-ts/engine`) now also exports `objectRefTarget`. The other ports'
  snapshot tests follow.
