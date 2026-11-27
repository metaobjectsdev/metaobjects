# template-codegen conformance corpus

Cross-port gate for the declarative Mustache template generator (SP-1).

Every port runs `spec.json` (a list of `{ name, template, scope, outputPattern }`
generators) over `metadata/meta.shop.json`, resolving templates from `templates/`,
and must produce output **byte-identical** to `expected/`.

The root case exercises the three per-entity-dictionary scopes:

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

## The `docs-view/` case

`docs-view/` is a second case with its own `spec.json`, `metadata/` (every file, loaded
together), `templates/`, `assets/` and `expected/`. Its entries read the **docs view**
(`docs/features/docs-view.md`) of the model alone: no verify payload, manifest or routes,
so `sources` is all `false`. It gates:

- the `perNode` scope with `match` (`"object.*"`, and a list `["object.entity"]`) and the
  `perRequirement` scope, each at `{path}`;
- `data: "docsView"` on `perModel` and `perPackage`;
- `subDir` (the site under `site/`) and `root`, the way back to it, used by every link
  (`{{root}}{{path}}`) and by a Markdown entry outside the site (`briefs/`);
- `assets` (`assets/` copied to `site/assets/`);
- `linkCheck`: every relative link in the checked entries lands on a file and an anchor,
  including links to pages a later entry renders.

The templates stay inside the subset every port's engine renders alike: no `.length`, no
number's truth, no dotted name inside a loop. TypeScript runs this case today; another port
runs it once it builds the docs view. A port that has no link check still matches the bytes.

Regenerate `expected/` after an intentional change to the data dict or scope walks
by pointing the generator at the `expected/` directory and committing the result
(see each port's conformance test). In TypeScript:
`UPDATE_TEMPLATE_CONFORMANCE=1 bun test packages/codegen-ts/test/template-codegen/conformance.test.ts`
from `server/typescript/` rewrites both cases.
