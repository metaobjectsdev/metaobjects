# Program D — Value-Object jsonb-column PATCH parity (Java / Kotlin / C#) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution model is **fork-per-port** (the FR-036 pattern): a fork owns one port's noisy Maven/dotnet/bun iteration, but the orchestrator independently re-runs each port's gate, runs code-review + code-simplifier, and commits. **Do not trust a fork's "green" — re-run the gate yourself.**

**Goal:** Make value-object jsonb columns (`field.object @objectRef @storage:jsonb`, single AND `@isArray`) fully PATCH-able — bind → nested-validate → write — in the Java, Kotlin, and C# codegen ports, so all five ports are byte-identical at the api-contract boundary (TS + Python already do this).

**Architecture:** Gate-first. Extend the shared `fixtures/api-contract-conformance/jsonb/` corpus with VO columns + PATCH scenarios that re-read via GET; confirm RED on Java/Kotlin/C# and GREEN on TS/Python. Then fix each port (C# smallest → Java biggest → Kotlin), teaching BOTH lanes (hand-rolled reference server + generated codegen). Close with an xhigh cross-port review before any release.

**Tech Stack:** TS (`codegen-ts` zod/Fastify), Python (`metaobjects` Pydantic/FastAPI), Java (`codegen-spring` JavaPoet/Spring), Kotlin (`codegen-kotlin` KotlinPoet/Exposed/Spring), C# (`MetaObjects.Codegen` Roslyn/EF Core). Conformance corpus: YAML fixtures under `fixtures/api-contract-conformance/`, two lanes per port (reference server + generated artifact) over Testcontainers Postgres (Java/Python generated lanes use an in-memory repo seam).

## Global Constraints

- **PUBLIC repo.** No other/private project names, no absolute home paths (`/home/...`) in ANY committed file including commit messages. A pre-commit hook enforces it; genericize, never `--no-verify`.
- **Commit directly to `main`** (project convention, no side branches unless asked). `main` is forward-only — never rebase/reset/force. `git fetch` before starting; `git show origin/main:<path>` for ground truth. Push to origin for durability.
- **Commit author** `Doug Mealing <doug@dougmealing.com>`. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: <session URL>
  ```
- **Named constants** for all metamodel strings (never inline `"field.object"`, `"object.value"`, subtype names, reserved JSON keys). TS: `packages/metadata/src/constants.ts` and per-domain `*-constants.ts`. No `any` in TS — use `unknown` and narrow. ESM only.
- **JVM generated code compiles under `allWarningsAsErrors`** — no unused imports, no always-true guards.
- **Scope = value-object columns only** (`field.object @storage:jsonb`, single AND `@isArray`). `field.map` (dict-of-VO) and the Kotlin `field.string @dbColumnType:jsonb` open-bag PATCH are STAGED OUT (spec §6) — do not touch them.
- **THE load-bearing correction (spec §0, empirically proven):** `jakarta …validateValue(Bean.class, prop, value)` does NOT cascade `@Valid` into a nested VO's constraints. Keep `validateValue` for the property's OWN constraints (`@NotNull`, `validator.array @Size`); ADD explicit `validator.validate(voElement)` per present VO element (iterate lists). C# = per-element `Validator.TryValidateObject(vo, …, validateAllProperties: true)` + manual recursion (it is non-recursive). Emit `@Valid` / `@field:Valid` on nested-VO members of generated JVM VO classes so depth ≥ 2 cascades.
- **Every mutation scenario re-reads via GET** to convict persistence (the C#/Kotlin generated lanes are full-stack vs Testcontainers PG).
- **A golden may ENCODE the bug** — verify current behavior before regenerating any golden.
- **Study the reference implementation (TS/Python) for the exact nested-validation semantics; don't re-derive.**
- **Authoritative design:** `docs/superpowers/specs/2026-07-14-program-d-vo-column-patch-parity-design.md`. This plan operationalizes it; the spec's §0–§7 are authoritative on mechanism.

---

## File Structure

**Shared fixture (Phase 0):**
- Modify: `fixtures/api-contract-conformance/jsonb/meta.json` — add `Marker` VO + 3 VO columns to `Document`.
- Modify: `fixtures/api-contract-conformance/jsonb/seed.json` — seed rows carry the required VO column (+ sample optional/array).
- Modify: `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-open-bag-roundtrip.yaml` — add `primaryMarker` to the two POST bodies (r2, r4) now that it is required.
- Create: `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml` — the new VO PATCH/POST scenario.
- Modify: `fixtures/api-contract-conformance/jsonb/README.md` — document the new columns + scenario.

**Per-port lane surfaces (each port's phase teaches BOTH):**
| Port | Reference server (add PATCH + VO cols) | Generated lane / DDL const | Codegen files to fix |
|---|---|---|---|
| TS | `server/typescript/packages/integration-tests/src/api-contract-jsonb-server.ts` | `.../src/api-contract-jsonb-generated-server.ts` | (codegen already handles VO PATCH — fix only latent bugs) |
| Python | `server/python/tests/integration/api_contract_jsonb_server.py` | `.../generated_jsonb_app.py` | `entity_model.py`, `router_generator.py` (fix only latent bugs) |
| C# | `server/csharp/MetaObjects.IntegrationTests/Api/JsonbReferenceServer.cs` (+ `JsonbFixture.cs` DDL/seed) | `JsonbGeneratedServerFactory.cs` (shares `JsonbFixture` DDL) | `RoutesGenerator.cs`, `EntityGenerator.cs`, `DbContextGenerator.cs` |
| Java | `server/java/integration-tests/src/test/java/com/metaobjects/integration/api/JsonbReferenceServer.java` (+ `JsonbCorpus.java` seed) | `GeneratedJsonbControllerHarness.java` | `SpringDtoGenerator.java`, `SpringControllerGenerator.java`, `SpringRepositoryGenerator.java`, `SpringTypeMapper.java`, new VO-record emitter |
| Kotlin | `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/jsonb/DocumentApiServer.kt` | `.../jsonb/generated/GeneratedDocumentControllerHarness.kt` | `KotlinSpringControllerGenerator.kt`, `KotlinEntityGenerator.kt` |

**Docs to update at the end:**
- `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md:134-143` — remove the "Object/value-typed columns are non-PATCHable" paragraph (the gap closes).
- `CHANGELOG.md` — Unreleased entry (this is a feature, not a release).

---

## The gate fixture (exact content — used by Phase 0)

The `Document` entity gains ONE reused VO type (`Marker`) and three columns exercising every axis: a **required** single VO (C#-4 metadata-required 400), a **nullable** single VO (tristate + present-null-clears), and a **nullable array** of VO (present-`[]` vs present-null distinct). The `body.row` assertion is a per-key **subset** match, so nullable additions leave `jsonb-open-bag-roundtrip.yaml`'s GET assertions green; the required `primaryMarker` is the one addition that forces touching that file's two POST bodies.

`Marker` carries `label` (`@required @maxLength 40`) so a nested-constraint violation (`null` / `""` / >40 chars) is a 400, and `score` (plain int).

---

## Task 1: Extend the gate fixture metadata + seed (shared)

**Files:**
- Modify: `fixtures/api-contract-conformance/jsonb/meta.json`
- Modify: `fixtures/api-contract-conformance/jsonb/seed.json`
- Modify: `fixtures/api-contract-conformance/jsonb/README.md`

**Interfaces:**
- Produces: `Document` entity with wire fields `id`, `title`, `payload` (open bag, unchanged), `primaryMarker` (required single `Marker`), `optionalMarker` (nullable single `Marker`), `markers` (nullable `Marker[]`). VO `Marker { label: string @required @maxLength 40; score: int }`. DB columns snake_case: `primary_marker`, `optional_marker`, `markers`.

- [ ] **Step 1: Rewrite `meta.json`** to add the `Marker` value object and the three VO columns. Full file:

```json
{
  "metadata.root": {
    "package": "acme::store",
    "children": [
      { "object.value": {
        "name": "Marker",
        "children": [
          { "field.string": { "name": "label", "@required": true, "@maxLength": 40 } },
          { "field.int":    { "name": "score" } }
        ]
      }},
      { "object.entity": {
        "name": "Document",
        "children": [
          { "source.rdb":       { "@table": "documents" } },
          { "field.long":       { "name": "id", "@filterable": true, "@sortable": true } },
          { "field.string":     { "name": "title", "@required": true, "@maxLength": 200, "@filterable": true, "@sortable": true } },
          { "field.string":     { "name": "payload", "@dbColumnType": "jsonb" } },
          { "field.object":     { "name": "primaryMarker",  "@objectRef": "Marker", "@storage": "jsonb", "@required": true } },
          { "field.object":     { "name": "optionalMarker", "@objectRef": "Marker", "@storage": "jsonb" } },
          { "field.object":     { "name": "markers",        "@objectRef": "Marker", "@storage": "jsonb", "isArray": true } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ]
      }}
    ]
  }
}
```

- [ ] **Step 2: Rewrite `seed.json`** so both seed rows carry the now-required `primaryMarker` (and row 1 exercises optional + array on the READ path):

```json
{
  "rows": [
    { "id": 1, "title": "alpha", "payload": { "seeded": true, "n": 1 },
      "primaryMarker": { "label": "seed-owner-a", "score": 1 },
      "optionalMarker": { "label": "seed-opt-a", "score": 2 },
      "markers": [ { "label": "m1", "score": 10 }, { "label": "m2", "score": 20 } ] },
    { "id": 2, "title": "beta",  "payload": { "k": "v" },
      "primaryMarker": { "label": "seed-owner-b", "score": 3 } }
  ]
}
```

- [ ] **Step 3: Update `README.md`** — add the three VO columns to the field table and note the new scenario. Add to the field table:

```markdown
| `primaryMarker`  | `field.object @objectRef=Marker @storage=jsonb @required` | required single VO — present-null → 400 |
| `optionalMarker` | `field.object @objectRef=Marker @storage=jsonb`           | nullable single VO — tristate            |
| `markers`        | `field.object @objectRef=Marker @storage=jsonb isArray`  | nullable array of VO — `[]` ≠ null       |
```

And add a "Value objects" note: `Marker { label: string @required @maxLength 40; score: int }`; the `jsonb-value-object-patch.yaml` scenario is the cross-port VO PATCH/POST gate (Program D).

- [ ] **Step 4: Sanity-check the fixture loads** (no test run yet — just parse via the TS loader, the canonical reference). Run:

```bash
cd server/typescript && bun -e "import { loadMetadata } from '@metaobjectsdev/metadata'; const r = await loadMetadata({ roots: ['../../fixtures/api-contract-conformance/jsonb'] }); console.log('loaded OK:', r.objects?.length ?? 'root', 'objects');"
```
Expected: prints "loaded OK" with no `ERR_*`. If it errors on `@required` on `field.object` or on `isArray`, STOP — re-verify the attr is registered (it is: `MetaField.isRequired` honors `@required`; `isArray` is the bare reserved keyword). Adjust only the fixture.

- [ ] **Step 5: Commit**

```bash
git add fixtures/api-contract-conformance/jsonb/meta.json fixtures/api-contract-conformance/jsonb/seed.json fixtures/api-contract-conformance/jsonb/README.md
git commit -m "test(program-d): add value-object columns to jsonb api-contract fixture

Marker VO + required/nullable single + nullable array VO columns on Document,
seed rows carry the required column. Gate metadata for cross-port VO-column
PATCH parity."
```

---

## Task 2: Write the VO-PATCH scenario + patch the existing scenario's POSTs

**Files:**
- Create: `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml`
- Modify: `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-open-bag-roundtrip.yaml`

**Interfaces:**
- Consumes: the `Document` fields from Task 1.
- Produces: the shared scenario both lanes of all 5 ports run. The runner applies `seed.json` fresh before each scenario file; the next implicit-id POST lands at id 3.

- [ ] **Step 1: Fix the existing open-bag scenario** — `primaryMarker` is now required, so the two POSTs (r2, r4) must supply it or they 400 on every enforcing port. Edit `jsonb-open-bag-roundtrip.yaml`:
  - In `r2` `body:` add `primaryMarker: { label: "gamma-owner", score: 1 }`.
  - In `r4` `body:` add `primaryMarker: { label: "delta-owner", score: 2 }`.
  - Leave every `expect.body.row` unchanged (subset match — they still only assert `id`/`title`/`payload`).

- [ ] **Step 2: Write the new scenario file** `jsonb-value-object-patch.yaml`. This covers POST (valid, nested-violation, missing-required) and PATCH (present-value single/array, nested-violation, present-null-clears, present-`[]`, present-null-array, absent-untouched, present-null-on-required, nested-null-on-required), each mutation re-read via GET:

```yaml
name: jsonb-value-object-patch
description: >
  Program D — cross-port value-object jsonb-column PATCH/POST parity. The
  Document entity carries a required single VO (primaryMarker), a nullable
  single VO (optionalMarker), and a nullable array-of-VO (markers), all
  field.object @storage:jsonb over the Marker value object
  (label @required @maxLength 40; score int). Every mutation re-reads via GET
  to convict persistence. Byte-identical across TS/Python/Java/Kotlin/C#,
  both lanes.
requests:
  # --- READ a seeded row: VO columns surface as parsed objects/arrays ---
  - id: r1
    method: GET
    path: /api/documents/1
    expect:
      status: 200
      body:
        row:
          id: 1
          title: "alpha"
          primaryMarker: { label: "seed-owner-a", score: 1 }
          optionalMarker: { label: "seed-opt-a", score: 2 }
          markers: [ { label: "m1", score: 10 }, { label: "m2", score: 20 } ]

  # --- POST valid single + array VO → 201 → persisted (id 3) ---
  - id: r2
    method: POST
    path: /api/documents
    body:
      title: "created"
      primaryMarker: { label: "owner-c", score: 5 }
      optionalMarker: { label: "opt-c", score: 6 }
      markers: [ { label: "a", score: 1 }, { label: "b", score: 2 } ]
    expect:
      status: 201
      body:
        hasId: true
        row:
          title: "created"
          primaryMarker: { label: "owner-c", score: 5 }
          markers: [ { label: "a", score: 1 }, { label: "b", score: 2 } ]
  - id: r3
    method: GET
    path: /api/documents/3
    expect:
      status: 200
      body:
        row:
          id: 3
          primaryMarker: { label: "owner-c", score: 5 }
          optionalMarker: { label: "opt-c", score: 6 }
          markers: [ { label: "a", score: 1 }, { label: "b", score: 2 } ]

  # --- POST nested-constraint violation (label > 40 chars) → 400 (CREATE gap) ---
  - id: r4
    method: POST
    path: /api/documents
    body:
      title: "bad-create"
      primaryMarker: { label: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", score: 1 }
    expect:
      status: 400

  # --- POST missing required VO column → 400 ---
  - id: r5
    method: POST
    path: /api/documents
    body:
      title: "no-owner"
    expect:
      status: 400

  # --- PATCH present valid single VO (optionalMarker) → 200 → persisted ---
  - id: r6
    method: PATCH
    path: /api/documents/1
    body:
      optionalMarker: { label: "patched-opt", score: 99 }
    expect:
      status: 200
  - id: r7
    method: GET
    path: /api/documents/1
    expect:
      status: 200
      body:
        row:
          optionalMarker: { label: "patched-opt", score: 99 }

  # --- PATCH present valid array VO (markers) → 200 → persisted ---
  - id: r8
    method: PATCH
    path: /api/documents/1
    body:
      markers: [ { label: "x", score: 7 }, { label: "y", score: 8 }, { label: "z", score: 9 } ]
    expect:
      status: 200
  - id: r9
    method: GET
    path: /api/documents/1
    expect:
      status: 200
      body:
        row:
          markers: [ { label: "x", score: 7 }, { label: "y", score: 8 }, { label: "z", score: 9 } ]

  # --- PATCH nested-constraint violation in array element → 400 ---
  - id: r10
    method: PATCH
    path: /api/documents/1
    body:
      markers: [ { label: "ok", score: 1 }, { label: "", score: 2 } ]
    expect:
      status: 400

  # --- PATCH present-null on nullable single → 200 → cleared (null) ---
  - id: r11
    method: PATCH
    path: /api/documents/1
    body:
      optionalMarker: null
    expect:
      status: 200
  - id: r12
    method: GET
    path: /api/documents/1
    expect:
      status: 200
      body:
        row:
          optionalMarker: null

  # --- PATCH present-[] on array → 200 → empty array (NOT null) ---
  - id: r13
    method: PATCH
    path: /api/documents/1
    body:
      markers: []
    expect:
      status: 200
  - id: r14
    method: GET
    path: /api/documents/1
    expect:
      status: 200
      body:
        row:
          markers: []

  # --- PATCH present-null on array → 200 → null (distinct from []) ---
  - id: r15
    method: PATCH
    path: /api/documents/1
    body:
      markers: null
    expect:
      status: 200
  - id: r16
    method: GET
    path: /api/documents/1
    expect:
      status: 200
      body:
        row:
          markers: null

  # --- PATCH absent (title only) → VO columns untouched ---
  - id: r17
    method: PATCH
    path: /api/documents/2
    body:
      title: "beta-renamed"
    expect:
      status: 200
  - id: r18
    method: GET
    path: /api/documents/2
    expect:
      status: 200
      body:
        row:
          title: "beta-renamed"
          primaryMarker: { label: "seed-owner-b", score: 3 }

  # --- PATCH present-null on REQUIRED VO column → 400 (C#-4 metadata-required) ---
  - id: r19
    method: PATCH
    path: /api/documents/2
    body:
      primaryMarker: null
    expect:
      status: 400

  # --- PATCH nested-member-null on required VO → 400 (nested recursion) ---
  - id: r20
    method: PATCH
    path: /api/documents/2
    body:
      primaryMarker: { label: null, score: 4 }
    expect:
      status: 400
```

- [ ] **Step 3: Verify the assertion helpers can express expected-`null` and expected-`[]`.** This is a prerequisite risk: the `body.row` subset asserters (`ApiContractAssertions` in each port) must treat an expected `null` value as "assert the key is present and null" (not "absent") and an expected `[]` as an empty list. Grep each helper:

```bash
cd <repo-root>
grep -n "Null\|null\|IsEmpty\|Count == 0\|isEmpty" server/csharp/MetaObjects.IntegrationTests/Api/ApiContractAssertions.cs
grep -n "null\|isEmpty\|List" server/java/integration-tests/src/test/java/com/metaobjects/integration/api/ApiContractAssertions.java
grep -rn "null\|isEmpty" server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/ApiContractAssertions.kt
grep -rn "null\|None\|== \[\]" server/python/tests/integration/*assert* server/python/tests/integration/api_contract_*.py
grep -rn "null\|undefined\|length === 0" server/typescript/packages/integration-tests/src/api-contract*.ts server/typescript/packages/integration-tests/test/api-contract-jsonb.test.ts
```
Expected: each `structuralEquals`/deep-equal treats `null == null` true and empty-list equality true. If a helper cannot distinguish expected-null from absent-key (i.e. it skips null expectations), add minimal support (assert key present + value null) across ALL FIVE helpers — a mechanical, cross-port, subset-preserving change. Record what you changed. **Do this before running scenarios**, else the present-null-clears assertions silently pass on absent keys.

- [ ] **Step 4: Commit**

```bash
git add fixtures/api-contract-conformance/jsonb/scenarios/
git commit -m "test(program-d): jsonb value-object PATCH/POST scenario + required-column POST fix

New jsonb-value-object-patch.yaml gates VO-column POST (valid/nested-violation/
missing-required) and PATCH (present single+array/nested-violation/present-null-
clears/present-[]/present-null-array/absent-untouched/required-null-400), each
re-read via GET. Existing open-bag POSTs now supply the required primaryMarker."
```

---

## Task 3: TS lane green (reference PATCH + confirm generated) — GATE anchor

**Files:**
- Modify: `server/typescript/packages/integration-tests/src/api-contract-jsonb-server.ts` (reference: add PATCH handler + VO columns + nested validation + tristate)
- Modify: `server/typescript/packages/integration-tests/src/api-contract-jsonb-generated-server.ts` (add VO columns to the provisioned DDL/seed)
- Possibly modify: `codegen-ts` (only if a latent VO-PATCH bug surfaces)

**Interfaces:**
- Consumes: fixture from Tasks 1–2.
- Produces: TS both lanes GREEN — the anchor proving the scenario is correct and the target behavior well-defined.

- [ ] **Step 1: Add VO columns to the reference server's schema + seed + GET/POST/PATCH.** In `api-contract-jsonb-server.ts` the CREATE TABLE (`:54-59`) has only `payload jsonb`; add `primary_marker jsonb NOT NULL`, `optional_marker jsonb`, `markers jsonb`. The reference is hand-rolled — it should validate `Marker` (label non-empty, ≤40) and required-ness IN CODE (return 400), independent of DB nullability, and implement PATCH with the FR-035 tristate (absent untouched / present-null clears nullable / present-null on `primary_marker` → 400 / present value validated + written). Model the PATCH arm on how the TPH reference server merges. GET returns VO columns as parsed objects/arrays.

- [ ] **Step 2: Add VO columns to the generated-lane server's provisioning.** In `api-contract-jsonb-generated-server.ts` the provisioned table (`:75-82`) must include the three VO jsonb columns; `applySeed` (`:99-114`) must insert `primary_marker` (+ optional/markers for row 1). The generated `Document.routes.ts` + entity file already emit the VO validation (UpdateSchema embeds `<Ref>InsertSchema`, `zod-validators.ts:396-422`), so no codegen change is expected — but see Step 4.

- [ ] **Step 3: Run BOTH TS lanes.**

```bash
cd server/typescript/packages/integration-tests && bun test test/api-contract-jsonb.test.ts --timeout 90000
```
Expected: all scenarios (open-bag + value-object-patch) PASS on both the reference and generated lanes.

- [ ] **Step 4: If the generated lane is RED, that's a latent TS VO-PATCH bug — fix it in `codegen-ts` (first-exercise over HTTP).** Likely suspects: the runtime update path not serializing a VO to jsonb on UPDATE; the required VO column's UpdateSchema making it `.nullable()` (present-null should 400, not clear). Fix minimally, re-run Step 3. Add a `codegen-ts` unit test if the fix is in a generator template.

- [ ] **Step 5: Typecheck.**

```bash
cd <repo-root> && bun run --filter '*' typecheck
```
Expected: clean.

- [ ] **Step 6: Code-review + simplify the TS diff, then commit.** (Reference-server + any codegen fix.)

```bash
git add server/typescript/
git commit -m "test(program-d): TS jsonb VO-column PATCH lane green (both lanes)

Reference server + generated-lane provisioning carry the Marker VO columns;
PATCH tristate + nested validation. <note any codegen fix>."
```

---

## Task 4: Python lane green (reference PATCH + confirm generated)

**Files:**
- Modify: `server/python/tests/integration/api_contract_jsonb_server.py` (reference: PATCH + VO columns + validation)
- Modify: `server/python/tests/integration/generated_jsonb_app.py` (in-memory seam + provisioning for VO columns)
- Possibly modify: `server/python/.../entity_model.py`, `router_generator.py` (latent bugs / wire-name pin)

**Interfaces:**
- Consumes: fixture from Tasks 1–2. Produces: Python both lanes GREEN.

- [ ] **Step 1: Add VO columns + PATCH to the reference server** (`api_contract_jsonb_server.py` + its `DocumentRepository`). Same contract as TS Step 1: nested `Marker` validation, required-ness in code, FR-035 tristate PATCH.

- [ ] **Step 2: Add VO columns to the generated-lane seam** (`generated_jsonb_app.py` `InMemoryDocumentRepository`, `:91-138`, update at `:128-133`). The generated `<Name>Patch` types VO fields as the full VO model (`entity_model.py:482-507`) and validates via `<Name>Patch(**dto)` (`router_generator.py:341`) — Pydantic recurses. No generator change expected.

- [ ] **Step 3: Wire-name pin (spec §1 caveat).** The VO read model keys by `@column` (`entity_model.py:266`); the Patch keys by wire name (`:364`, FR-036 #3). Our `Marker` members have no `@column`, so wire == column and it's moot — but VERIFY: if a nested VO validation keys by column and a present-value scenario 400s spuriously, add a wire-name pin to the VO validation model. Only touch this if a scenario actually fails.

- [ ] **Step 4: Run BOTH Python lanes.**

```bash
cd server/python && .venv/bin/python -m pytest tests/integration/test_api_contract_jsonb.py -q
```
Expected: all scenarios PASS on both lanes. Fix any latent bug minimally; re-run.

- [ ] **Step 5: Code-review + simplify, then commit.**

```bash
git add server/python/
git commit -m "test(program-d): Python jsonb VO-column PATCH lane green (both lanes)"
```

---

## Task 5: GATE checkpoint — confirm RED on Java/Kotlin/C#

**Files:** none (verification only).

- [ ] **Step 1: Run the three JVM/dotnet lanes and confirm RED.** These MUST fail now (VO columns unhandled in codegen; reference servers lack PATCH + VO columns):

```bash
# Java
cd server/java && mvn -q -pl codegen-spring install && mvn -q -f integration-tests/pom.xml test -Dtest='JsonbGeneratedApiContractConformanceTest,JsonbApiContractConformanceTest' ; echo "read: server/java/integration-tests/target/surefire-reports/*.txt"
# Kotlin
cd server/java && mvn -q -pl codegen-kotlin install && mvn -q -f integration-tests-kotlin/pom.xml test -Dtest='JsonbApiContractConformanceTest,JsonbGeneratedApiContractConformanceTest'
# C#
cd server/csharp && dotnet test MetaObjects.IntegrationTests --filter "FullyQualifiedName~ApiContractJsonb"
```
Expected: RED on all three (compile errors or scenario failures). This confirms the gate bites. **A PG-testcontainer readiness flake is not a code failure — re-run.** If a port is unexpectedly GREEN, the fixture didn't reach that lane — investigate before proceeding.

- [ ] **Step 2: Record the RED baseline** (paste the failing scenario ids / compile errors into the execution notes). No commit.

---

## Task 6: C# port — VO-column PATCH (smallest)

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/RoutesGenerator.cs` (merge-loop typed VO arms + metadata-required + POST/PATCH nested validation)
- Modify: `server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs` (VO POCO validation attributes via `withAttributes`)
- Modify: `server/csharp/MetaObjects.IntegrationTests/Api/JsonbReferenceServer.cs` + `JsonbFixture.cs` (reference PATCH + VO columns/DDL/seed)
- Test: `server/csharp/MetaObjects.Codegen.Tests` (unit), `MetaObjects.IntegrationTests` (both lanes)

**Interfaces:**
- Consumes: gate fixture + assertion helpers. Produces: C# both jsonb lanes GREEN; VO POCOs carry validation attributes; PATCH merge loop assigns VO CLR properties.

- [ ] **Step 1: Emit VO POCO validation attributes.** In `EntityGenerator.cs`, `EmitValueObjectPoco` (`:560`) currently passes `withAttributes: false` (`:596`, `:602`) so VO members have no `[Required]`/`[StringLength]`. Change VO member emission to pass `withAttributes: true` (split validation attrs from EF-mapping attrs — validation attrs are safe on a `ToJson` owned type; keep EF-mapping attrs like `[Column]` off VO members if they would conflict). Verify `[Required(AllowEmptyStrings = true)]` (required-string non-empty per FR-036) + `[StringLength]`/`[MaxLength]` now emit on `Marker.label`.

- [ ] **Step 2: Add a `codegen` unit test** asserting the emitted `Marker` POCO carries `[Required` and `[StringLength(40` (or `[MaxLength(40`). Run it RED, implement Step 1, run GREEN.

```bash
cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "FullyQualifiedName~ValueObject"
```

- [ ] **Step 3: PATCH merge-loop typed VO arms.** In `RoutesGenerator.cs` `AppendPartialMergeLoop` (`:497`), the `FindProperty`-miss `continue` (`:501-503`) silently skips owned-nav VO columns. For each VO field the codegen KNOWS, emit a **typed per-field arm** BEFORE the generic loop (keyed on the wire property name) that:
  - present value → deserialize JSON to `Marker` / `List<Marker>` (System.Text.Json), run recursive validation (Step 4), assign `existing.<Nav> = <deserialized>` (the CLR property on the tracked entity — NOT `entry.CurrentValues[...]` / `entry.Navigation(...)`; EF's `.ToJson` persists via full-document replacement on `DetectChanges`).
  - present null on a **nullable** VO column → `existing.<Nav> = null`.
  - present null on a **required** VO column → `return Results.BadRequest(new { error = "validation" })`. The required-ness comes from **metadata at codegen** (the field's `@required`), NOT `target.IsNullable` (`:513`) — EF models the owned-nav nullable even when `@required` (`DbContextGenerator.cs:365-369`), so keying off EF metadata would 500.
  - absent → untouched (not in the JSON object).

- [ ] **Step 4: Recursive VO validation on PATCH and POST.** `Validator.TryValidateObject(vo, ctx, results, validateAllProperties: true)` is non-recursive — emit a helper that validates each present `Marker` element and recurses into any nested-VO members, returning 400 on any violation. Wire it into BOTH the PATCH arms (Step 3) and the POST/create handler (C# does not validate nested VO on create today — this flushes the r4/r5 CREATE gap). A missing required VO column on POST → 400.

- [ ] **Step 5: Teach the C# reference server.** `JsonbReferenceServer.cs` wires only GET/POST (`:92`); add a `PATCH`/`PUT` arm modeled on `TphReferenceServer.cs:159/277`, plus VO-column handling in GET/POST and the merge. Update `JsonbFixture.cs` DDL const (`:20-24`) to add `primary_marker jsonb NOT NULL`, `optional_marker jsonb`, `markers jsonb`, and `ApplySeedAsync` (`:44`) to bind them (`NpgsqlDbType.Jsonb`). The generated lane shares this DDL via `JsonbGeneratedServerFactory` → same `JsonbFixture`.

- [ ] **Step 6: Run BOTH C# lanes.**

```bash
cd server/csharp && dotnet test MetaObjects.Codegen.Tests && dotnet test MetaObjects.IntegrationTests --filter "FullyQualifiedName~ApiContractJsonb"
```
Expected: GREEN on both lanes, all scenarios. Re-run PG flakes.

- [ ] **Step 7: Independently re-verify** (do not trust a fork): re-run Step 6 from a clean state. Then code-review + code-simplifier on the C# diff; fix findings.

- [ ] **Step 8: Commit.**

```bash
git add server/csharp/
git commit -m "feat(program-d): C# codegen PATCHes value-object jsonb columns

Merge loop emits typed VO CLR-property arms (deserialize -> validate -> assign);
VO POCOs carry validation attributes; recursive TryValidateObject on PATCH and
POST; present-null-on-required 400 driven by metadata, not EF nullability.
Reference server + JsonbFixture taught the VO columns + PATCH."
```

---

## Task 7: Java port — VO-column PATCH (biggest; new VO layer)

**Files:**
- Create: a new VO-record emitter (mirror `SpringPayloadGenerator.java:263` record emit; wire into the entity DTO path). Place per the existing generator package convention.
- Modify: `SpringDtoGenerator.java` (stop excluding `ObjectField`; add object arms to `<Entity>Dto` + `<Entity>Patch`)
- Modify: `SpringControllerGenerator.java` (validate: `validateValue` own + explicit `validate(voElement)` per element)
- Modify: `SpringRepositoryGenerator.java` (DTO-typed seam already carries VO once the DTO does — verify)
- Modify: `SpringTypeMapper.java` (add an `ObjectField` VO arm so `javaTypeName` returns the VO record type instead of throwing at `:124-126`)
- Modify: `server/java/integration-tests/.../JsonbReferenceServer.java` (PATCH + VO columns) + `JsonbCorpus.java` seed
- Test: `codegen-spring` unit tests + `JsonbApiContractConformanceTest,JsonbGeneratedApiContractConformanceTest`

**Interfaces:**
- Consumes: gate fixture. Produces: a Java record per `object.value` (jakarta constraints + `@Valid` on nested-VO members); `<Entity>Dto`/`<Entity>Patch` carry VO fields; controller validates present VO values; repo seam round-trips the jsonb column.

- [ ] **Step 1: VO-record emitter.** Emit a Java record per `object.value` reachable from an entity's `field.object`, with jakarta constraints on its members (reuse `validationAnnotations` `SpringDtoGenerator.java:572-655`) and `@Valid` on any nested-VO member (depth ≥ 2 cascade, spec §0). Study `SpringPayloadGenerator.java:263` (`resolveObjectFieldType` `:311`, `SUBTYPE_VALUE` resolve `:511-514`) — it already emits VO records for the payload surface; mirror its shape, wired for the entity-CRUD path (NOT the payload path). Add a `codegen-spring` unit test asserting the emitted `Marker` record has `@NotNull`/`@Size(max = 40)` on `label`.

- [ ] **Step 2: `SpringTypeMapper` VO arm.** Add an `ObjectField`-with-`@objectRef` arm to `javaTypeName` (`:74-127`) returning the VO record type (`List<Marker>` when `isArray`), so it no longer throws at `:124-126`. Keep the existing `field.string @dbColumnType=jsonb → Object` open-bag arm (`:75-84`) untouched.

- [ ] **Step 3: DTO + Patch object arms.** In `SpringDtoGenerator.java` stop excluding `ObjectField` from `scalarFields` (`:443`) / `settableFields` (`:291-304`); add object component-type handling so `<Entity>Dto` and `<Entity>Patch` carry the VO field (bind via Jackson `treeToValue` to the VO record / `List<VO>`, mirror the existing `bind(...)` at `:254-269`). Handle VO-inside-VO enum qualification in `patchComponentType` (`:311-316`) if a nested VO carries an enum (our gate VO does not — keep minimal). Also drop the parallel `ObjectField` skips at `:327`, `:362-363` where they gate the DTO/patch field set (NOT the sort/filter allowlists — VO columns are neither filterable nor sortable; leave `SpringControllerGenerator.java:169/410` and `SpringFilterAllowlistGenerator.java:112` skipping `ObjectField`).

- [ ] **Step 4: Controller validation (spec §0).** In `SpringControllerGenerator.java`, the vanilla PATCH handler (`:301-324`) runs `validateValue(<Dto>.class, field, value)` (`:316`) — keep it for the property's own constraints, and ADD an explicit `validator.validate(voElement)` per present VO element (iterate `List<VO>`), returning 400 on any violation. For POST/create (`:281-288`, `validator.validate(dto)` at `:283`): `validate(bean)` DOES cascade `@Valid` on the DTO's VO field — so ensure the `<Entity>Dto`'s VO field carries `@Valid` (then create validation works via the existing `validate(dto)`), OR add explicit per-element validation. VERIFY which by test, prefer the `@Valid`-on-DTO-field path (less code).

- [ ] **Step 5: Repo seam.** `SpringRepositoryGenerator.java:123` is DTO-typed — once the DTO carries the VO field (Step 3), `patch`/`create`/`update` round-trip it. Verify the in-memory seam (`InMemoryDocumentRepositorySource`) in the generated harness stores + returns the VO field; update the seam if it filters to scalars.

- [ ] **Step 6: Teach the Java reference server.** `JsonbReferenceServer.java` routes only GET/POST (`:116-136`); add a PATCH arm (JDBC merge with the FR-035 tristate + nested `Marker` validation → 400), add the VO columns to the schema (`:72-79`) + `create`/`findById` (`:138-160`), and `JsonbCorpus.seedRows()` (`:39-50`) to carry `primaryMarker` (+ optional/markers row 1).

- [ ] **Step 7: Run BOTH Java lanes.**

```bash
cd server/java && mvn -q -pl codegen-spring install && mvn -q -f integration-tests/pom.xml test -Dtest='JsonbGeneratedApiContractConformanceTest,JsonbApiContractConformanceTest'
# read: server/java/integration-tests/target/surefire-reports/*.txt
```
Expected: GREEN both lanes. Generated code MUST compile under `allWarningsAsErrors` (no unused imports, no always-true guards). Re-run PG flakes.

- [ ] **Step 8: Independently re-verify + code-review + code-simplifier on the Java diff; fix findings. Commit.**

```bash
git add server/java/codegen-spring/ server/java/integration-tests/
git commit -m "feat(program-d): Java codegen-spring PATCHes value-object jsonb columns

New VO-record emitter (jakarta constraints + @Valid on nested VO members);
SpringTypeMapper VO arm; <Entity>Dto/<Entity>Patch carry VO fields; controller
validates present VO values (validateValue own-constraints + explicit
validate(voElement) per element, spec section 0). Reference server taught PATCH."
```

---

## Task 8: Kotlin port — VO-column read + create + patch

**Files:**
- Modify: `codegen-kotlin/.../KotlinSpringControllerGenerator.kt` (include VO in `rowToEntity` read, create insert loop, `patchSettableFields`; validate)
- Modify: `codegen-kotlin/.../KotlinEntityGenerator.kt` (add `@field:Valid` on nested-VO members)
- Modify: `server/java/integration-tests-kotlin/.../jsonb/DocumentApiServer.kt` (PATCH + VO columns)
- Test: `codegen-kotlin` unit tests + `JsonbApiContractConformanceTest,JsonbGeneratedApiContractConformanceTest` (Kotlin)

**Interfaces:**
- Consumes: gate fixture. Produces: the generated `DocumentController` reads, creates, AND patches VO columns via `MetaJsonbMapper`; validates present values; Kotlin VO data classes carry `@field:Valid` on nested-VO members.

- [ ] **Step 1: Include VO in read + create + patch.** In `KotlinSpringControllerGenerator.kt`: `rowToEntity` (`:300-306`) skips `ObjectField`/`MapField` on read — include `ObjectField` (bind via `MetaJsonbMapper`), keeping `MapField` excluded (staged out). Create insert loop (`:374-391`, skip at `:376`) — include `ObjectField`. `patchSettableFields` (`:161-165`) excludes `ObjectField`/`MapField`/open-bag — remove the `ObjectField` exclusion only (keep `MapField` + `isJsonbOpenBag` excluded — both staged out). PATCH-only would leave VO columns write-only → read-backs fail, hence read+create too.

- [ ] **Step 2: `@field:Valid` on nested VO members.** `KotlinEntityGenerator.kt` `validationAnnotations` (`:348`+) emits no `Valid` today, so a parent `@Valid` won't recurse. Add `@field:jakarta.validation.Valid` on VO-typed members of generated VO data classes (`:142-159`, attaching alongside `validationAnnotations` at `:152-157`). Add a `codegen-kotlin` unit test asserting the `Marker`-referencing member carries `@field:Valid` and `Marker.label` carries `@field:Size(max = 40)`/`@field:NotNull`.

- [ ] **Step 3: Validate on PATCH (spec §0).** In the PATCH handler bind+validate loop (`:429-459`; `validateValue` at `:440`/`:444`), keep `validateValue` for own constraints and ADD explicit `validator.validate(voElement)` per present VO element (iterate the list). Bind VO via `MetaJsonbMapper` (Jackson — NOT `VO.serializer()`; kotlinx `@Serializable` is decorative per the codebase decision). Required-null on the required VO column → 400 (the required-null guard at `:410`); present-null on a nullable VO column clears.

- [ ] **Step 4: Teach the Kotlin reference server.** `DocumentApiServer.kt` routes only GET+POST (`:107-110`); add a PATCH arm (Exposed merge + FR-035 tristate + nested `Marker` validation → 400), add VO columns to `DocumentTable` (`:183-189`, jsonb via `MetaJsonbMapper`/Jackson) and the GET/POST handlers + `applySeed` (`:69-85`). Note the generated harness seeds THROUGH the generated controller's own POST (`GeneratedDocumentControllerHarness.kt:157-158`) — so create must handle VO for seeding to succeed.

- [ ] **Step 5: Run BOTH Kotlin lanes.**

```bash
cd server/java && mvn -q -pl codegen-kotlin install && mvn -q -f integration-tests-kotlin/pom.xml test -Dtest='JsonbApiContractConformanceTest,JsonbGeneratedApiContractConformanceTest'
```
Expected: GREEN both lanes; generated code compiles under `allWarningsAsErrors`. Re-run PG flakes.

- [ ] **Step 6: Independently re-verify + code-review + code-simplifier; fix findings. Commit.**

```bash
git add server/java/codegen-kotlin/ server/java/integration-tests-kotlin/
git commit -m "feat(program-d): Kotlin codegen PATCHes value-object jsonb columns

Generated controller reads, creates, and patches VO columns via MetaJsonbMapper
(Jackson); VO data classes carry @field:Valid on nested VO members; present-value
validation (validateValue own + explicit validate(voElement), spec section 0).
Reference server taught PATCH."
```

---

## Task 9: Cross-port xhigh review, docs, final verification

**Files:**
- Modify: `server/java/codegen-spring/.../KNOWN_GAPS.md` (remove the closed-gap paragraph `:134-143`)
- Modify: `CHANGELOG.md` (Unreleased feature entry)

**Interfaces:**
- Consumes: all port work. Produces: a clean, reviewed, byte-identical cross-port VO-column PATCH.

- [ ] **Step 1: Run an xhigh cross-port code review.** FR-036's xhigh review caught 11 divergences the corpus missed. Invoke `/code-review high` (or the ultra multi-agent variant) over the full Program-D diff, focused on cross-port divergence: does every port validate nested VO identically (byte-identical 400s)? Does every port treat present-null-array vs present-`[]` identically? Does every reference server match its generated lane? Fix all confirmed findings + add a gate scenario for any behavior a finding shows is ungated.

- [ ] **Step 2: Re-run ALL FIVE ports' jsonb lanes** from a clean state (independent verification, not a fork's word):

```bash
# TS
cd server/typescript/packages/integration-tests && bun test test/api-contract-jsonb.test.ts --timeout 90000
# Python
cd server/python && .venv/bin/python -m pytest tests/integration/test_api_contract_jsonb.py -q
# C#
cd server/csharp && dotnet test MetaObjects.IntegrationTests --filter "FullyQualifiedName~ApiContractJsonb"
# Java
cd server/java && mvn -q -f integration-tests/pom.xml test -Dtest='JsonbGeneratedApiContractConformanceTest,JsonbApiContractConformanceTest'
# Kotlin
cd server/java && mvn -q -f integration-tests-kotlin/pom.xml test -Dtest='JsonbApiContractConformanceTest,JsonbGeneratedApiContractConformanceTest'
```
Expected: GREEN everywhere, both lanes.

- [ ] **Step 3: Remove the closed KNOWN_GAPS paragraph** (`KNOWN_GAPS.md:134-143`, "Object/value-typed columns are non-PATCHable"). Replace with a one-line note that VO-column PATCH shipped (Program D), and that `field.map` + the Kotlin open-bag PATCH remain staged-out follow-ups (spec §6).

- [ ] **Step 4: CHANGELOG Unreleased entry** — "Value-object jsonb columns (`field.object @storage:jsonb`, single + `@isArray`) are PATCH-able cross-port (Java/Kotlin/C# brought to TS/Python parity); nested VO validation on POST + PATCH; gated by `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml` in both lanes, all five ports. `field.map` and the Kotlin open-bag PATCH remain staged-out follow-ups."

- [ ] **Step 5: Commit docs.**

```bash
git add server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md CHANGELOG.md
git commit -m "docs(program-d): close the VO-column-PATCH known gap; CHANGELOG entry"
```

- [ ] **Step 6: Push to origin.**

```bash
git fetch origin && git status  # confirm no divergence
git push origin main
```

- [ ] **Step 7: This is a FEATURE, not a release.** Do NOT publish. A coordinated release (0.16.x→0.17.0 / 7.8.x→7.9.0, or per the owner) happens only when the owner explicitly asks.

---

## Follow-ups explicitly OUT of scope (do NOT do here)

- **`field.map @objectRef`** (dict-of-VO jsonb): no persistence fixture exists; needs a persistence-conformance `field.map` roundtrip column FIRST (SP-H), then the HTTP tier.
- **Kotlin `field.string @dbColumnType:jsonb` open-bag PATCH**: needs a `kotlinx …Json.parseToJsonElement(node.toString())` bridge; Kotlin is the only laggard, so the open-bag PATCH scenario can't land cross-port until it's fixed.
- **TPH entities with VO columns**: Java/Kotlin TPH unions skip `ObjectField`. Out of scope.
