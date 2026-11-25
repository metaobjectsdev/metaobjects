# Rubrics (written before any output was read)

One point per item unless noted. Every item is a fact or rule the current skill teaches; the
question is whether the trimmed skill still gets it out of the model. A wrong or harmful
statement (invented vocabulary, advice the skill forbids) is noted beside the score.

## authoring-1-new-entity (max 9)
1. Fused `type.subType` keys, attributes `@`-prefixed, reserved keys bare (`name`, `isArray`, `children`).
2. `field.uuid` id plus `identity.primary`.
3. `amountPaid` is `field.currency` with `@currency: USD` (not a float or decimal).
4. `status` is `field.enum` with `@values`; `validator.requiredWhen` ties `rejectReason` to REJECTED.
5. `createdAt` is `field.timestamp` with `@autoSet: onCreate`.
6. `productUrl` is `field.uri`; `tags` is `field.string` with bare `isArray: true`.
7. FK fields with `identity.reference` (`@references`) to Product and Customer.
8. Delete rules sit on the child side: cascade for Product, restrict for Customer.
9. `source.rdb` with `@table: reviews`; no invented attribute.

## authoring-2-adoption (max 8)
1. `@table: user_settings`; the physical column names reproduced (`@column`, at least `display_nm`), nothing renamed.
2. Both uuids are `field.uuid`.
3. `notifPrefs` is `field.map` with `@objectRef` to a declared `object.value` (channel enum, enabled boolean).
4. `favoriteSkus` is `field.string` with `isArray: true`.
5. `rawImport` is `field.string` with `@dbColumnType: jsonb`, not required.
6. FK to Customer: `identity.reference`, and BOTH `@onDelete` and `@onUpdate` pinned to `no-action`.
7. Nullability reproduced (`@required: true` on the NOT NULL columns only).
8. `@maxLength: 80` on the display name.

## authoring-3-yaml (max 7)
1. `metadata:` root with `package`, children of fused `type.subType:` keys, explicit subtypes.
2. Attributes bare, no `@`.
3. Enum members quoted (`"Y"`, `"N"`, `"on"`, `"off"`).
4. `identity.primary` with `generation: increment`; `identity.secondary` for `key`.
5. Array of longs via `field.long[]:` or bare `isArray: true`.
6. `notes`: `required: true` plus `validator.length` with `min: 0`.
7. `field.date` for the date, `field.long` id.

## codegen-1-standing-rule (max 6)
1. Neither hand-edit generated files nor hand-write the routes.
2. The rule about MetaObjects does not cover generators in your own repo; no permission needed.
3. `meta eject routes`, then change the copy in `codegen/generators/`.
4. Wire the owned copy in `metaobjects.config.ts`.
5. Output location through generator/target configuration, not by moving files.
6. Regenerate and check: typecheck or `meta verify --codegen`.

## codegen-2-nothing-generated (max 6)
1. Not broken: `meta init` wires no generators and the list is the complete list.
2. `meta gen --list --format json --probe` as the catalog.
3. One framework on the api layer (`routes`, not also `routes-hono`).
4. Client: form generator and the TanStack generators together.
5. Wire unchanged generators from the package; do not eject what you will not change.
6. Run gen, read warnings, typecheck; commit the hash manifest.

## codegen-3-write-generator (max 6)
1. Generator shape: `name` plus `generate` returning `{ path, content }` (e.g. `perEntity`).
2. `obj.fields()` (inherited included), not the own-only form.
3. `resolvedIsArray()` and `isRequired`, not the raw `isArray`.
4. Abstract objects filtered out.
5. Registered in `metaobjects.config.ts` (or scaffolded with `meta generator new`).
6. `meta verify --codegen` in CI; output deterministic.

## codegen-4-refused-write (max 5)
1. The hash manifest decides: the edited file no longer matches what gen recorded, so the write is refused by name.
2. Move the helper to a non-generated file (or change the generator or metadata), then regenerate.
3. `handEdits: "overwrite"` on that generator's entry.
4. False: the header is not the write decision; deleting it is just another edit.
5. Commit `.metaobjects/.gen-state/.hashes/`.

## verify-1-retired-vocab-java (max 5)
1. A retired name is a load error (sealed registry, no shim); nothing runs until the model loads.
2. `meta upgrade` to preview, `meta upgrade --apply` to rewrite.
3. Node-only, so `npx meta upgrade` in the Java project.
4. `@readOnly` became `@mutability`.
5. Do not loosen strict mode; upgrade refuses what has no single answer with a non-zero exit.

## verify-2-python-schema-change (max 6)
1. Metadata first, then regenerate with the Python tool.
2. Migration SQL from Node `meta migrate --dialect postgres --slug ...` (Python has none).
3. Apply through the tool; never `ALTER TABLE` by hand, with the reason.
4. Schema gate: Node `meta verify --db <url>`.
5. Codegen gate: `metaobjects verify`.
6. A bare verify does not run the database gate (or: always pass `--dialect`).

## verify-3-hand-edit-passes (max 4)
1. Not broken: a hand edit is reported apart from drift.
2. `verify.handEdits: "fail"` in `.metaobjects/config.json` (or `--forbid-hand-edits`).
3. See the edit: delete the file, `meta gen`, `git diff -R -- <file>`, `git checkout -- <file>`.
4. Make the change in the metadata (`@maxLength`).

## verify-4-uuid-and-psql (max 5)
1. Not fine: verify cannot catch a model that is consistently wrong; use `field.uuid`.
2. A CI ratchet lint for the uuid-as-string smell.
3. The live database is derived: metadata, then `meta migrate`; never by hand.
4. A recovery that ends with the metadata, the migration chain and the database agreeing.
5. `meta verify --db` as a done-check, not only in CI.

## runtime-ui-1-urls (max 6)
1. All five URLs right: `/api/post_categories`, `/api/days`, `/api/addresses`, `/api/http_servers`, `/api/order_summaries` (2 points; 1 point for four).
2. `filter[name][like]=` and `filter[rank][gte]=3`.
3. `sort=createdAt:desc`, `limit=20`, `offset=20`, `withCount=1`.
4. Body is `{ rows, total }`.
5. 404 `{ "error": "not_found" }`; currency is integer minor units.

## runtime-ui-2-physical-names (max 4)
1. No literal table or column name; the column is not derived from the field name.
2. Uses the `OrderNames` constants.
3. Checks the names artifact exists: it is opt-in, so wire the `names` generator first.
4. Prefers a typed handle (Drizzle column) where one exists.

## runtime-ui-3-client-wiring (max 5)
1. Grids are opt-in: add `layout.dataGrid` with `@columns`.
2. Pair the grid generator with the grid-hook generator.
3. `baseUrl="/api"` on `EntityFetcherProvider`.
4. The fetcher contract: one fetcher at the root that throws on non-2xx.
5. Currency arrives as integer minor units; format on the client, no float arithmetic.

## prompts-1-migrate-first (max 6)
1. Migrates the prompt first; does not append to the hand-built string.
2. Snapshot before, byte-compare after.
3. Payload `object.value` with only the fields the text uses (messages as a nested value list).
4. `template.prompt` with `@payloadRef` and `@textRef`; the text in an external template file.
5. `@responseRef` and the generated extractor replace the regexes.
6. Then the requested instruction, added in the template text.

## prompts-2-declare-and-parse (max 6)
1. Payload `object.value` with a nested `field.object` + `@objectRef` + `isArray: true`.
2. `template.prompt` with `@payloadRef` and `@textRef`; text external, iterating the orders.
3. `@responseRef` to a response value with an enum `risk` and a string-array `reasons`.
4. `@format` stays text and `@responseFormat` is json: the two are not confused.
5. Tolerant extract for the raw reply; strict parse only for a guaranteed-JSON body.
6. The generated response-format fragment, or the `verify --templates` gate.

## prompts-3-variants-and-email (max 6)
1. No branching or concatenation of prose in the service.
2. Vocabulary as payload data.
3. A boolean flag section for the premium-only block.
4. One resolver from tier to payload; a snapshot per variant.
5. Email is `template.output` with `@kind: email`, `@subjectRef` and `@htmlBodyRef`, no `@textRef`.
6. No reply parser for it.

## audit-1-owned-generators (max 7)
1. `queries`: proven unmodified, so recommend the package import (`owned-generator-stock-copies`, with the undo command).
2. `entity`: identical, but its runtime adapter is edited, so it is a customization and not a finding.
3. `routes`: `0 of your own` is not proof; check history; stale by version is `owned-generator-stale`.
4. `barrel`: "your formatting" does not prove unmodified; confirm from history.
5. `form`: lines of its own are not proof of customization either; report behind and own separately.
6. One total, unmodified lines over all owned-generator lines; the package import is not a finding.
7. Read-only: proposes, edits nothing.

## audit-2-classify (max 7)
1. Hand-written customer CRUD routes: CODEGEN CANDIDATE (high).
2. The validator: a drift finding, and the divergence (100 against 200) is the finding.
3. Recursive CTE: BESPOKE (keep).
4. `CustomerTable` derives from generated metadata: flagged good.
5. Demo route: stub trap, "candidate (future), not DB-backed".
6. Findings carry the contract fields (id, pillar, surface, locations, impact, effort, confidence, metadata_sketch, next_command, parity_gate, tier).
7. Does not pick 100 or 200 silently: a human decision, or a parity gate named.

## audit-3-gate-and-versions (max 5)
1. Gate answer NO, scored RUNS BUT DOES NOT BLOCK, with the reasons (exit code swallowed, deploy path skips it).
2. The untracked local hook does not count.
3. Version lines differ by ecosystem, so the numbers cannot be compared by eye.
4. Compare the `metamodelVersion` each port reports, and each port's release; a mismatch is a finding.
5. Flags a port that is not on its ecosystem's latest release.

## fit-1-small-single-app (max 6)
1. The verdict in the prescribed shape.
2. Trajectory not inferred from size: both branches, low confidence.
3. Seams: none found.
4. Knows Prisma on TypeScript is targeted, so FULL would keep Prisma.
5. Facts cited as given; limits listed under "what you would not get".
6. Writes nothing into the target; never says "not a fit" wholesale.

## fit-2-multi-service-estate (max 6)
1. CONTRACT SPINE.
2. Both seams named with both sides.
3. Go has no port: only the TypeScript and Python sides generate.
4. The gate named: codegen drift check in each consumer's CI, the consumer's compiler catches the rest.
5. Says why the wider and narrower scopes were rejected.
6. Verdict shape, cited facts, limits.

## fit-3-large-finished-app (max 6)
1. NOT WORTH IT, said plainly.
2. Reasons: no seam; Hibernate-only entities are not targeted; MySQL is outside `meta migrate` and `verify --db`.
3. Works the scope table: why each wider scope was rejected.
4. Uses the team's trajectory answer.
5. Names what would change the verdict (a real boundary).
6. Verdict shape.
