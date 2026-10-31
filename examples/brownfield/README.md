# Moving existing models into MetaObjects

Three small projects that each start with hand-written models and no MetaObjects dependency in
their source. They are the worked examples for
[Adopting existing models](../../docs/features/adopting-existing-models.md).

| Project | Existing code | What proves it |
|---|---|---|
| [`drizzle/`](drizzle) | Drizzle tables and a Postgres schema | `tsc` over `proof/`, then `meta verify --db` |
| [`zod/`](zod) | Zod request schemas | `tsc` over `proof/`, then `proof/rules.ts` |
| [`pydantic/`](pydantic) | Pydantic models | `python -m pytest proof/` |

Each one holds the model, the config and the proof, in the state just after step 3 of the recipe.
Nothing is generated yet, and the source files have not moved. Generated output is not committed.

These run in CI, including the deliberate mismatches: see
`server/typescript/packages/cli/test/integration/brownfield-recipe.test.ts` and
`server/python/tests/codegen/test_brownfield_recipe.py`.
