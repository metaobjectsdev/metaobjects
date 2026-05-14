# Meta Forge metadata reference

This doc describes how **Meta Forge** extends the [metaobjects metamodel](../metaobjects-metadata/METAMODEL.md) with provenance attributes and descriptive memory types. If you're authoring `.meta/memory/*.json` files for a Meta-Forge-driven project, read this *and* `METAMODEL.md`.

> **For agentic assistants:** the metaobjects rules in METAMODEL.md apply unchanged here — attribute uniqueness, inline-vs-child equivalence, `super`/overlay semantics, package paths. This doc only adds Meta-Forge-specific names.

## 1. The `@forge*` attribute namespace

Meta Forge stores provenance, confidence, and other knowledge-graph concerns as inline attributes on any metadata child. All Meta Forge attribute names are camelCase and start with `forge`:

| Attribute | Subtype | Applies to | Meaning |
|---|---|---|---|
| `@forgeConfidence` | double (0..1) | all | Confidence the record is correct |
| `@forgeSource` | string | all | Who/what captured this: `human`, `claude`, `ts-ast`, `drizzle`, `prisma`, `openapi`, `llm-from-commits`, `llm-from-prs`, `ingest:ts-ast`, `ingest:drizzle`, `ingest:zod` |
| `@forgeCapturedAt` | string (ISO datetime) | all | When this record was captured |
| `@forgeLastValidatedCommit` | string | all | Last commit-sha against which this record was validated |
| `@forgePrimaryLocation` | string | object | Primary file path for the entity in the codebase |
| `@forgeOccurrences` | stringarray | object | Other file paths where the entity appears |
| `@forgeRationale` | string | decision | Why the decision was made |
| `@forgeAlternatives` | stringarray | decision | Alternatives considered |
| `@forgeScope` | string \| stringarray | decision, principle | `global` or array of glob patterns |
| `@forgeStatement` | string | principle | What the principle states |
| `@forgeEnforcement` | string | principle | `advisory` or `enforced` |
| `@forgePatternDescription` | string | convention | Description of the convention's pattern |
| `@forgeExamples` | stringarray | convention, principle | Example code paths |
| `@forgeCounterExamples` | stringarray | principle | Anti-pattern examples |
| `@forgeAppliesTo` | stringarray | convention | Glob patterns where the convention applies |
| `@forgeTerm` | string | glossary | The defined term |
| `@forgeSynonyms` | stringarray | glossary | Synonyms |
| `@forgeDefinition` | string | glossary | Definition body |
| `@forgeCodeAnchors` | properties | glossary | Map of `kind → name` references |
| `@forgeSeeAlso` | stringarray | glossary | Cross-references |
| `@forgeWhatWasTried` | string | failure | What was attempted |
| `@forgeWhyItFailed` | string | failure | Reason for failure |

Constants for these names live in `@metaobjects/sdk` as `FORGE_ATTR_CONFIDENCE`, `FORGE_ATTR_SOURCE`, etc. Always import the constant rather than hard-coding the string.

## 2. New top-level metadata types

`@metaobjects/sdk`'s `registerForgeTypes(registry)` adds these to a `TypeRegistry`:

| Type | Subtypes | Purpose |
|---|---|---|
| `decision` | `base`, `global`, `scoped` | An architectural or design decision |
| `principle` | `base`, `advisory`, `enforced` | A design principle |
| `convention` | `base` | A coding/structural convention |
| `glossary` | `base` | Domain-term definition |
| `failure` | `base` | A recorded failure mode |

A `.meta/memory/*.json` file can mix `object` children (entities, drive codegen + runtime) with `decision`/`principle`/etc. children (descriptive context for Claude's reasoning). `forge gen` and `forge migrate` walk only the `object` children; the descriptive types are visible to AI tooling and ignored by code generation.

## 3. `.meta/memory/` layout

```
.meta/
├── config.json
├── memory/
│   ├── common.json                    optional — shared base fields/validators
│   ├── <app>.json                     your entity package
│   ├── <other-package>.json           split however you want
│   └── _pending/<package>.json        proposed packages, ignored by forge gen/migrate
├── migrations/                        written by forge migrate
├── .gen-state/                        codegen merge base (gitignored)
├── AGENTS.md                          scaffolded by forge init
└── CLAUDE.md                          same content as AGENTS.md
```

`forge gen` and `forge migrate` glob `memory/*.json` (non-recursive, top-level files only), excluding `_pending/`. Files inside packages are recombined by Loader cross-file using `super:` references.

## 4. Worked example — entity + decision in one file

```json
{
  "metadata": {
    "package": "myapp",
    "children": [
      {
        "object": {
          "name": "User",
          "subType": "map",
          "@forgeConfidence": 0.95,
          "@forgeSource": "human",
          "@forgePrimaryLocation": "src/db/users.schema.ts",
          "children": [
            {"field": {"name": "id", "super": "..::common::id"}},
            {"field": {"name": "email", "subType": "string",
              "@dbColumn": "email_address",
              "children": [{"validator": {"subType": "required"}}]
            }},
            {"identity": {"name": "pk", "subType": "primary", "@fields": ["id"]}}
          ]
        }
      },
      {
        "decision": {
          "name": "useTanstackQuery",
          "subType": "global",
          "@forgeConfidence": 0.9,
          "@forgeSource": "human",
          "@forgeRationale": "Real-time invalidation matters for live game state.",
          "@forgeAlternatives": ["swr", "redux-toolkit-query"]
        }
      }
    ]
  }
}
```

## 5. When to propose new metadata

| Situation | What Claude should do |
|---|---|
| Adding a field to an existing entity | Edit the existing `object`'s `children` array; add the new `field` node |
| Adding a new entity in an existing domain | Append a new `object` to the appropriate package file |
| Capturing an architectural choice that affects how entities are built | Add a `decision` to the relevant package file with `@forgeRationale` + `@forgeAlternatives` |
| Recording a coding convention | Add a `convention` with `@forgePatternDescription` + `@forgeAppliesTo` globs |
| Naming a domain term | Add a `glossary` entry with `@forgeTerm` + `@forgeDefinition` |

## 6. See also

- [`packages/metaobjects-metadata/METAMODEL.md`](../metaobjects-metadata/METAMODEL.md) — the underlying metaobjects rules
- [SP5 design](../../docs/specs/2026-05-12-v0.2-sp5-cli-extensions-design.md) — full CLI spec
- [`@metaobjects/sdk`'s `forge-types.ts`](src/forge-types.ts) — constants source of truth
