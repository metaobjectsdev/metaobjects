# metamodel-docs

The shared corpus for the vocabulary reference pages the `metamodel-docs` generator writes in
every port: `INDEX.md`, `providers.md` and one `types/<family>.md` per type family. They
document the metamodel itself (every registered type, subtype and attribute, and the provider
that registers each), not a project's model, so there is one case and no input model.

**The TypeScript generator is the source of the expected bytes.** A port that disagrees with
the corpus is wrong, not the corpus. Regenerate it with `bun run scripts/regen-metamodel-docs.ts`
after a vocabulary, description or template change, then run `scripts/sync-doc-templates.sh`
so every port's template copy follows.

## How a page is made

Every page is a shared Mustache template fed the data a builder computes:

| Page | Template (canonical copy) |
|---|---|
| `INDEX.md` | `templates/metamodel/index.md.mustache` |
| `providers.md` | `templates/metamodel/providers.md.mustache` |
| `types/<family>.md` | `templates/metamodel/type-page.md.mustache` |

Each port builds the data from what it already holds:

- **its registry vocabulary manifest**, the one `registry-conformance` byte-matches to
  `expected-registry.json`: the types, attributes, descriptions, rules and child rules;
- **its embedded provider definitions** (the vendored `spec/metamodel/*.json`): which provider
  owns each type and contributes each attribute, and each attribute's default. The manifest is
  provider-blind by design (ADR-0050), so this is the only place that fact lives;
- **`templates/metamodel/provider-descriptions.json`**, shipped beside the templates: each
  provider's one-line description. The TypeScript test holds it equal to the descriptions on
  the TypeScript provider objects.

The builder makes every decision (sorting, table cells, joined lists, links, the provider and
default of each attribute); the template only lays the lines out. So a case has two checks:

1. **Builder.** The port's builder produces `data/<page>.json` (compare as JSON values).
2. **Page.** Rendering the page's template with that data produces `expected/<page>` byte for
   byte, and the port writes exactly the pages `expected/` holds.

Ownership follows the definitions: a definition's `types[]` entries are what that provider
owns, with their inline attributes; its `extends[]` entries are attributes it contributes to a
type another provider owns (`"*"` resolves to every subtype the manifest lists for that type);
the universal `*.*` entry's attributes are common attributes. The first definition to declare
an attribute on a type names its provider and default, and an attribute a subtype inherits
from `<type>.base` takes the base's. Documentation (common) attributes are left off the type
pages and listed once on the providers page.
