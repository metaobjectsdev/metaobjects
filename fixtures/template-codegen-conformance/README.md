# template-codegen conformance corpus

Cross-port gate for the declarative Mustache template generator (SP-1).

Every port runs `spec.json` (a list of `{ name, template, scope, outputPattern }`
generators) over `metadata/meta.shop.json`, resolving templates from `templates/`,
and must produce output **byte-identical** to `expected/`.

The corpus exercises all three built-in scopes:

- **`perEntity`** (`entity.mustache` → `<Name>.txt`) — the neutral per-entity data
  dict: fields (name/type/required/isArray/maxLength), and Order's `product`
  relationship.
- **`perPackage`** (`package.mustache` → `<package>/_package.txt`) — one file per
  package, listing its entities.
- **`perModel`** (`model.mustache` → `_model.txt`) — one file for the whole model.

The render engine is already byte-equal across ports (`fixtures/render-conformance/`);
this corpus gates the *new* surface: the structural data dict, the scope names
(`perEntity`/`perPackage`/`perModel`), and the output-pattern grammar
(`{name}`/`{Name}`/`{package}`).

Regenerate `expected/` after an intentional change to the data dict or scope walks
by pointing the generator at the `expected/` directory and committing the result
(see each port's conformance test).
