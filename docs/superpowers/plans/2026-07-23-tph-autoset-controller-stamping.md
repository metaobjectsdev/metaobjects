# TPH + `@autoSet` controller stamping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generated TPH (single-table discriminator) controller/router stamp `field.timestamp @autoSet` above the consumer seam, and lock it with a cross-port api-contract gate.

**Architecture:** Mirror the already-shipped vanilla ADR-0045 stamping onto the per-subtype TPH write path in the three ports that don't do it (Java, Kotlin, Python), verify the two that do (C#, TS), then add one `tph-autoset-patch.yaml` scenario that runs on both the reference and generated lanes of all five ports — the scenario is the enforcement mechanism.

**Tech Stack:** Kotlin (KotlinPoet-adjacent string-builder codegen, Exposed), Python (FastAPI router codegen), Java (Spring controller string-builder codegen), C# (verify), TypeScript (verify); shared YAML fixtures in `fixtures/api-contract-conformance/tph/`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-tph-autoset-controller-stamping-design.md` (read it first).
- **ADR-0045:** the generated API surface owns metamodel write semantics — stamp in the generated controller/router *above* the consumer repository seam; persistence-layer stamping stays as defense-in-depth. No new metamodel vocabulary.
- **Never land a red lane:** the cross-port `tph-autoset-patch.yaml` scenario is committed **only after** all five ports' TPH lanes (generated + reference) pass. Generated-controller fixes (Tasks 1–3) touch no shared fixture, so they red nothing.
- **No-churn:** a hierarchy with no `@autoSet` field must emit byte-identical TPH output. Every fixed port gets a no-churn assertion.
- **Named constants:** never inline metamodel strings; reuse each port's existing `@autoSet` helpers (Kotlin `KotlinGenUtil.isAutoSetField`/`autoSetPolicy` + `KotlinTypeMapper.nowExpr`; Python `_auto_set_split`/`_auto_set_stamp_lines`/`_auto_set_stamp_expr`; Java `AutoSetSupport`).
- **Sentinel:** the old-timestamp sentinel is `"2000-01-01T00:00:00"`; the `@autoSet` columns are named `autoCreatedAt` (onCreate) + `autoUpdatedAt` (onUpdate) — chosen to match the vanilla `fixtures/api-contract-conformance/seed.json` exactly.
- **Public repo:** no private project names, no absolute home paths in any committed file.
- **Author/commit trailers:** commit as `Doug Mealing <doug@dougmealing.com>`; end each commit message with the `Co-Authored-By: Claude Opus 4.8` + `Claude-Session:` trailers. Commit to `main` (forward-only; do not rebase/reset). Do not push unless asked.

---

## File Structure

**Generated-controller fixes (Tasks 1–3):**
- `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinSpringControllerGenerator.kt` — `emitTph` per-subtype create/update stamping.
- `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTphPlan.kt` — `subtypeSettableFields` excludes `@autoSet`.
- `server/python/src/metaobjects/codegen/generators/router_generator.py` — `_render_tph_router` threads the stamp lines.
- `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringControllerGenerator.java` — `emitTph` per-subtype stamping.
- `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringDtoGenerator.java` — `settableFields` excludes `@autoSet`.

**Cross-port gate (Task 4):**
- `fixtures/api-contract-conformance/tph/meta.json` — two `@autoSet` columns on the `Auth` base.
- `fixtures/api-contract-conformance/tph/seed.json` — sentinel on the seeded rows.
- `fixtures/api-contract-conformance/tph/scenarios/tph-autoset-patch.yaml` — new (committed last).
- Per-port TPH reference servers + generated-lane harnesses (5 ports) — stamp + direct-insert seed:
  - TS `server/typescript/packages/integration-tests/src/api-contract-tph-server.ts` + `api-contract-tph-generated-server.ts`
  - C# `server/csharp/MetaObjects.IntegrationTests/Api/TphReferenceServer.cs` + `TphGeneratedServerFactory.cs`
  - Java `server/java/integration-tests/src/test/java/com/metaobjects/integration/api/tph/**`
  - Kotlin `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/tph/**`
  - Python `server/python/tests/integration/generated_tph_app.py` + the tph reference server

**Per-port codegen unit tests (extended in Tasks 1–3):**
- `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinAutoSetStampingTest.kt`
- `server/python/tests/codegen/test_router_autoset.py`
- `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringAutoSetStampingTest.java`

**Execution note:** Tasks 1, 2, 3 are independent and parallelizable (one per-port subagent each), exactly as the vanilla `@autoSet` gate was built. Task 4 is the integrative gate and must run after 1–3 land.

---

## Task 1: Kotlin generated TPH controller stamps `@autoSet`

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTphPlan.kt` (`subtypeSettableFields`, ~line 146)
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinSpringControllerGenerator.kt` (`emitTph`, lines 626–988)
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinAutoSetStampingTest.kt`

**Interfaces:**
- Consumes: existing helpers `KotlinGenUtil.isAutoSetField(field): Boolean`, `KotlinGenUtil.autoSetPolicy(field): String` (`KotlinGenUtil.AUTO_SET_ON_UPDATE`), `KotlinTypeMapper.nowExpr(field): String` — all already used by the vanilla `emit()`.
- Produces: no new public API; a generated TPH controller whose per-subtype `create<Sub>` stamps onCreate+onUpdate from one captured `now()` and whose `update<Sub>` bumps onUpdate on every PATCH.

- [ ] **Step 1: Write the failing tests**

Add to `KotlinAutoSetStampingTest.kt` a TPH fixture (base with two `@autoSet` timestamps + one subtype) and three assertions. Use the same in-test loader pattern the existing vanilla cases in this file use to produce controller source; generate via `KotlinSpringControllerGenerator` and read the emitted `AuthController.kt`.

```kotlin
// TPH base Auth carries autoCreatedAt(onCreate)+autoUpdatedAt(onUpdate); BridgeAuth extends it.
private val TPH_AUTOSET_JSON = """
{ "metadata.root": { "package": "acme::auth", "children": [
  { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
    { "source.rdb": { "@table": "auths" } },
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "type", "@values": ["Bridge"] } },
    { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
    { "field.timestamp": { "name": "autoCreatedAt", "@autoSet": "onCreate" } },
    { "field.timestamp": { "name": "autoUpdatedAt", "@autoSet": "onUpdate" } },
    { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
  ]}},
  { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
    { "field.int": { "name": "quantity", "@required": true } }
  ]}}
]}}
"""

@Test
fun `tph per-subtype create stamps both autoSet columns from one captured now`() {
    val src = generateTphControllerSource(TPH_AUTOSET_JSON, "Auth")   // helper mirrors the vanilla test's generate-and-read
    val createBody = methodBody(src, "fun createBridge")
    assertTrue(createBody.contains("val autoSetNow0 ="), "create captures a now()-val")
    assertTrue(createBody.contains("it[autoCreatedAt] = autoSetNow0"), "onCreate stamped from the captured now()")
    assertTrue(createBody.contains("it[autoUpdatedAt] = autoSetNow0"), "onUpdate stamped from the same now() (created==updated)")
    assertFalse(createBody.contains("it[autoCreatedAt] = dto."), "autoSet is never bound from the caller DTO")
}

@Test
fun `tph per-subtype update bumps only onUpdate and never rewrites onCreate`() {
    val src = generateTphControllerSource(TPH_AUTOSET_JSON, "Auth")
    val updateBody = methodBody(src, "fun updateBridge")
    assertTrue(updateBody.contains("it[AuthTable.autoUpdatedAt] ="), "PATCH bumps onUpdate")
    assertFalse(updateBody.contains("it[AuthTable.autoCreatedAt] ="), "PATCH never rewrites onCreate")
}

@Test
fun `tph controller without autoSet is byte-identical (no stamping scaffolding)`() {
    val src = generateTphControllerSource(NO_AUTOSET_TPH_JSON, "Auth")  // reuse the existing plain tph fixture shape
    assertFalse(src.contains("autoSetNow"))
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server/java && mvn -q -pl codegen-kotlin test -Dtest=KotlinAutoSetStampingTest`
Expected: FAIL — the two TPH assertions fail (the generated `createBridge` currently binds `it[autoCreatedAt] = dto.autoCreatedAt`, no `autoSetNow` val; `updateBridge` never touches the columns).

- [ ] **Step 3: Exclude `@autoSet` from the TPH settable SSOT**

In `KotlinTphPlan.subtypeSettableFields` (the `.filter { ... }` returning the settable fields), add the `@autoSet` exclusion so the `<Sub>Validation` shape and the PATCH-settable set both drop it:

```kotlin
return subtype.metaFields.filterNot {
    it is ObjectField || it is MapField || KotlinTypeMapper.isJsonbOpenBag(it)
}.filter {
    it.name != pk && it.name != discField &&
        !KotlinGenUtil.isAutoSetField(it)   // #203/ADR-0045: server-owned; controller stamps it
}
```

- [ ] **Step 4: Stamp in `emitTph`**

In `KotlinSpringControllerGenerator.emitTph`, immediately after `writableFields` is computed (line ~671), add the autoSet field sets (base-owned union columns; mirrors the vanilla `emit()` lines 195–207) and exclude them from `writableFields`:

```kotlin
// #203/ADR-0045: @autoSet columns on the union table are stamped by the controller, never bound
// from the per-subtype create body. Same computation as the vanilla emit(); the columns live on
// the base (shared by every subtype row in the single table).
val insertAutoSetFields = base.metaFields.filter {
    KotlinGenUtil.isAutoSetField(it) && it.name != pkFieldName
}
val onUpdateAutoSetFields = insertAutoSetFields.filter {
    KotlinGenUtil.autoSetPolicy(it) == KotlinGenUtil.AUTO_SET_ON_UPDATE
}
val autoSetNames = insertAutoSetFields.map { it.name }.toSet()
val insertNowVal = LinkedHashMap<String, String>() // nowExpr -> local val name
insertAutoSetFields.forEach { f ->
    insertNowVal.getOrPut(KotlinTypeMapper.nowExpr(f)) { "autoSetNow${insertNowVal.size}" }
}
```

Then change the `writableFields` filter (line 671–672) to also drop `@autoSet`:

```kotlin
val writableFields = scalarFields.map { it.name }
    .filter { it != plan.discriminatorField && it != pkFieldName && it !in autoSetNames }
```

In the per-subtype **create** handler (lines 885–904), before `val newId = $table.insert {`, emit the captured now()-vals, and after the `writableFields` bind loop stamp the autoSet columns:

```kotlin
append("    fun create$sfx(@RequestBody dto: $shortName): ResponseEntity<Any> = transaction {\n")
// ...existing per-field validation loop over stPatch...
for ((expr, valName) in insertNowVal) append("        val $valName = $expr\n")
append("        val newId = $table.insert {\n")
append("            it[${plan.discriminatorField}] = $disc\n")
// ...existing writableFields bind loop (now autoSet-free)...
for (f in insertAutoSetFields) {
    append("            it[${f.name}] = ${insertNowVal[KotlinTypeMapper.nowExpr(f)]}\n")
}
append("        }[$table.$pkFieldName]\n")
```

In the per-subtype **update** handler (lines 919–972), reproduce the vanilla `mustStampOnUpdate` control flow (vanilla lines 483–568): when `onUpdateAutoSetFields.isNotEmpty()`, run the `update{}` on every PATCH (drop the `if (listOf(...).any { body.has(it) })` guard), bump each onUpdate column first, then apply the present patch values; when there are no settable columns but onUpdate must bump, emit a standalone `update{}` that only bumps:

```kotlin
val mustStampOnUpdate = onUpdateAutoSetFields.isNotEmpty()
if (stPatch.isNotEmpty()) {
    val settableNamesList = stPatch.joinToString(", ") { "\"${it.name}\"" }
    if (!mustStampOnUpdate) append("        if (listOf($settableNamesList).any { body.has(it) }) {\n")
    append("            try {\n")
    // ...existing present-value bind + validate loop...
    append("                $table.update({ ($table.$pkFieldName eq id) and ($table.${plan.discriminatorField} eq $disc) }) {\n")
    for (field in onUpdateAutoSetFields) {
        append("                    it[$table.${field.name}] = ${KotlinTypeMapper.nowExpr(field)}\n")
    }
    // ...existing per-field `if (has$cap) it[col] = ...` applies...
    append("                }\n")
    append("            } catch (e: com.fasterxml.jackson.databind.JsonMappingException) {\n")
    append("                return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
    append("            }\n")
    if (!mustStampOnUpdate) append("        }\n")
} else if (mustStampOnUpdate) {
    append("        $table.update({ ($table.$pkFieldName eq id) and ($table.${plan.discriminatorField} eq $disc) }) {\n")
    for (field in onUpdateAutoSetFields) {
        append("            it[$table.${field.name}] = ${KotlinTypeMapper.nowExpr(field)}\n")
    }
    append("        }\n")
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server/java && mvn -q -pl codegen-kotlin test -Dtest=KotlinAutoSetStampingTest`
Expected: PASS (all TPH + vanilla cases).

- [ ] **Step 6: Run the Kotlin codegen no-churn/output-compiles suite**

Run: `cd server/java && mvn -q -pl codegen-kotlin test`
Expected: PASS — existing golden/compile tests unchanged for non-`@autoSet` hierarchies.

- [ ] **Step 7: Commit**

```bash
cd <repo-root>
git add server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinSpringControllerGenerator.kt \
        server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTphPlan.kt \
        server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinAutoSetStampingTest.kt
git -c user.name="Doug Mealing" -c user.email="doug@dougmealing.com" commit -m "feat(codegen-kotlin): TPH per-subtype controller stamps @autoSet (ADR-0045, #203/#229)

<trailers>"
```

---

## Task 2: Python generated TPH router stamps `@autoSet`

**Files:**
- Modify: `server/python/src/metaobjects/codegen/generators/router_generator.py` (`_render_tph_router`, lines 478–697)
- Test: `server/python/tests/codegen/test_router_autoset.py`

**Interfaces:**
- Consumes: module helpers `_auto_set_split(entity) -> (on_create, on_update)`, `_auto_set_stamp_lines(fields, comment) -> list[str]`, `_auto_set_stamp_expr` — all already defined and used by the vanilla `render_router`.
- Produces: no new public API; a TPH router whose per-subtype `create_..._sfx` stamps onCreate+onUpdate from one `_asnow` and whose `update_..._sfx` pops onCreate + bumps onUpdate.

- [ ] **Step 1: Write the failing tests**

Add to `test_router_autoset.py` a TPH fixture (base with the two `@autoSet` columns + one subtype) and assertions against the TPH render path. Build the `object_index` via `metaobjects.codegen.generators.m2m_codegen.build_object_index(entities)` and call `RouterGenerator().render_router(base_entity, index)` (TPH is dispatched inside `render_router` when a plan resolves).

```python
TPH_AUTOSET = """
{ "metadata.root": { "package": "acme::auth", "children": [
  { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
    { "source.rdb": { "@table": "auths" } },
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "type", "@values": ["Bridge"] } },
    { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
    { "field.timestamp": { "name": "autoCreatedAt", "@autoSet": "onCreate" } },
    { "field.timestamp": { "name": "autoUpdatedAt", "@autoSet": "onUpdate" } },
    { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
  ]}},
  { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
    { "field.int": { "name": "quantity", "@required": true } }
  ]}}
]}}
"""

def test_tph_router_imports_datetime_when_autoset_present() -> None:
    src = _render_tph(TPH_AUTOSET, "Auth")   # helper: load, build index, render base
    assert "import datetime as _dt" in src

def test_tph_per_subtype_create_stamps_both_autoset_columns() -> None:
    body = _handler_body(_render_tph(TPH_AUTOSET, "Auth"), "def create_auths_bridge")
    assert "_asnow = _dt.datetime.now(_dt.timezone.utc)" in body
    assert 'dto["autoCreatedAt"] = _asnow' in body
    assert 'dto["autoUpdatedAt"] = _asnow' in body

def test_tph_per_subtype_update_pops_oncreate_and_bumps_onupdate() -> None:
    body = _handler_body(_render_tph(TPH_AUTOSET, "Auth"), "def update_auths_bridge")
    assert 'dto.pop("autoCreatedAt", None)' in body
    assert 'dto["autoUpdatedAt"] = _asnow' in body
    assert 'dto["autoCreatedAt"] = ' not in body

def test_tph_router_without_autoset_is_byte_identical() -> None:
    src = _render_tph(TPH_PLAIN, "Auth")   # a base with no @autoSet field
    assert "import datetime as _dt" not in src
    assert "_asnow" not in src
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server/python && uv run pytest tests/codegen/test_router_autoset.py -v -k tph`
Expected: FAIL — the TPH create/update handlers currently pass `dto` straight to `repo.create`/`repo.update` with no stamp lines and no `import datetime`.

- [ ] **Step 3: Compute the stamp lines in `_render_tph_router`**

Near the top of `_render_tph_router` (after `short_name`/`snake`/`plural` are set), compute the per-subtype autoSet lines and whether the module needs the datetime import. `@autoSet` columns live on the base and are shared by every subtype (resolving `_auto_set_split(st.entity)` picks up the inherited base columns):

```python
on_create_auto, on_update_auto = _auto_set_split(entity)   # base-owned; shared by all subtypes
has_autoset = bool(on_create_auto or on_update_auto)
create_autoset = _auto_set_stamp_lines(
    on_create_auto + on_update_auto,
    "#203/ADR-0045: stamp @autoSet columns (server-owned; caller ignored).",
)
update_autoset = [
    f'    dto.pop("{f.name}", None)  # onCreate @autoSet is write-once (server-owned)'
    for f in on_create_auto
] + _auto_set_stamp_lines(
    on_update_auto,
    "#203/ADR-0045: bump onUpdate @autoSet column(s) (server-owned).",
)
```

- [ ] **Step 4: Add the datetime import + thread the stamp lines into the per-subtype handlers**

After `parts.append("from __future__ import annotations")` in `_render_tph_router`, add the conditional import (mirror the vanilla path):

```python
if has_autoset:
    parts.append("")
    parts.append("import datetime as _dt")
```

In the per-subtype **create** handler block (the `parts.append('@router.post("/{seg}", ...)')` section, ~lines 625–635), insert `create_autoset` after the `{sub}Create(**dto)` validation `try/except` and before `return repo.create("{val}", dto)`:

```python
parts.append("        return JSONResponse(status_code=400, content={\"error\": \"validation\"})")
parts.extend(create_autoset)          # <-- stamp onCreate + onUpdate above the repo seam
parts.append(f'    return repo.create("{val}", dto)')
```

In the per-subtype **update** handler block (~lines 649–668), insert `update_autoset` after the `{sub}Patch(**dto)` validation `try/except` and before `saved = repo.update("{val}", {pk_param}, dto)`:

```python
parts.append("        return JSONResponse(status_code=400, content={\"error\": \"validation\"})")
parts.extend(update_autoset)          # <-- pop onCreate, bump onUpdate above the repo seam
parts.append(f'    saved = repo.update("{val}", {pk_param}, dto)')
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server/python && uv run pytest tests/codegen/test_router_autoset.py -v`
Expected: PASS (TPH + vanilla + non-autoSet no-churn).

- [ ] **Step 6: Run the full router codegen suite (no-churn)**

Run: `cd server/python && uv run pytest tests/codegen/test_router_generator.py tests/codegen/test_tph_codegen.py -v`
Expected: PASS — non-`@autoSet` TPH output unchanged.

- [ ] **Step 7: Commit**

```bash
cd <repo-root>
git add server/python/src/metaobjects/codegen/generators/router_generator.py \
        server/python/tests/codegen/test_router_autoset.py
git -c user.name="Doug Mealing" -c user.email="doug@dougmealing.com" commit -m "feat(python-codegen): TPH per-subtype router stamps @autoSet (ADR-0045, #203/#229)

<trailers>"
```

---

## Task 3: Java generated TPH controller stamps `@autoSet`

**Files:**
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringControllerGenerator.java` (`emitTph`, per-subtype create/update)
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringDtoGenerator.java` (`settableFields` — exclude `@autoSet`)
- Test: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringAutoSetStampingTest.java`

**Interfaces:**
- Consumes: `AutoSetSupport.hasAutoSetFields(entity): boolean`, `AutoSetSupport.hasOnUpdateFields(entity): boolean`; the generated DTO methods `<Dto>.stampForInsert(dto)` and `<Patch>.stampAutoSetOnUpdate()` used by the vanilla path (lines 294, 341).
- Produces: a generated TPH controller whose per-subtype create calls `stampForInsert` before `repository.createWithType(...)` and whose per-subtype update stamps onUpdate before `repository.patchByIdAndType(...)`.

- [ ] **Step 1: Write the failing tests**

Add TPH cases to `SpringAutoSetStampingTest.java`, using the same generate-and-read pattern the file's vanilla cases use, against a base carrying the two `@autoSet` columns (reuse the JSON shape from Task 1/2). Assert the generated `AuthController.java`:

```java
@Test
void tphPerSubtypeCreateStampsAutoSetBeforeDelegating() {
    String src = generateTphController(TPH_AUTOSET_JSON, "Auth");
    String createBody = methodBody(src, "createBridge");
    // stamp above the consumer seam, then delegate — mirrors the vanilla createArg
    assertTrue(createBody.contains(".stampForInsert(dto)"),
        "per-subtype create stamps @autoSet before createWithType");
    assertTrue(createBody.matches("(?s).*stampForInsert\\(dto\\).*createWithType.*"),
        "stamp precedes the repository delegation");
}

@Test
void tphPerSubtypeUpdateStampsOnUpdate() {
    String src = generateTphController(TPH_AUTOSET_JSON, "Auth");
    String updateBody = methodBody(src, "updateBridge");
    assertTrue(updateBody.contains("stampAutoSetOnUpdate"),
        "per-subtype update bumps onUpdate before patchByIdAndType");
}

@Test
void tphControllerWithoutAutoSetIsByteIdentical() {
    String src = generateTphController(NO_AUTOSET_TPH_JSON, "Auth");
    assertFalse(src.contains("stampForInsert"));
    assertFalse(src.contains("stampAutoSetOnUpdate"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server/java && mvn -q -pl codegen-spring test -Dtest=SpringAutoSetStampingTest`
Expected: FAIL — the TPH per-subtype create currently emits `repository.createWithType("Bridge", dto)` with no `stampForInsert`, and the update has no `stampAutoSetOnUpdate`.

- [ ] **Step 3: Exclude `@autoSet` from `SpringDtoGenerator.settableFields`**

In `SpringDtoGenerator.settableFields`, add the `@autoSet` exclusion (so the `<Sub>Dto` shape and the controller's validated set both drop it), matching how the vanilla path treats `@autoSet` as server-owned. Read the existing predicate and add `&& !AutoSetSupport.isAutoSet(field)` (use the same predicate `AutoSetSupport` exposes for the vanilla `settableFields`; if only `hasAutoSetFields` exists, add a field-level `isAutoSet(MetaField)` helper to `AutoSetSupport` and use it consistently with the vanilla exclusion).

- [ ] **Step 4: Stamp in `emitTph`**

In `SpringControllerGenerator.emitTph`'s per-subtype **create** (the block emitting `repository.createWithType("<disc>", dto)`), mirror the vanilla `createArg` (line 294): when `AutoSetSupport.hasAutoSetFields(st.entity())`, wrap the argument in `stampForInsert`:

```java
String createArg = AutoSetSupport.hasAutoSetFields(st.entity())
    ? subDto + ".stampForInsert(dto)" : "dto";
src.append("        ").append(dtoName).append(" saved = repository.createWithType(\"")
   .append(disc).append("\", ").append(createArg).append(");\n");
```

In the per-subtype **update** (the block building `<Sub>Patch` and calling `repository.patchByIdAndType(...)`), mirror the vanilla `patch.stampAutoSetOnUpdate()` (line 341): when `AutoSetSupport.hasOnUpdateFields(st.entity())`, stamp the patch before delegating:

```java
if (AutoSetSupport.hasOnUpdateFields(st.entity())) {
    src.append("        patch.stampAutoSetOnUpdate();\n");
}
src.append("        return repository.patchByIdAndType(id, \"").append(disc)
   .append("\", patch.assignedValues())\n");
```

Confirm the generated `<Sub>Dto` / `<Sub>Patch` actually expose `stampForInsert` / `stampAutoSetOnUpdate` for a TPH subtype DTO (they are emitted by `SpringDtoGenerator` when the DTO has `@autoSet` fields). If the TPH subtype DTO path does not emit them, extend `SpringDtoGenerator` to emit them for the subtype DTO exactly as for the vanilla DTO (same `AutoSetSupport`-gated code path). Add a codegen assertion for their presence to `SpringAutoSetStampingTest` if you touch the DTO generator.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server/java && mvn -q -pl codegen-spring test -Dtest=SpringAutoSetStampingTest`
Expected: PASS.

- [ ] **Step 6: Run the codegen-spring suite (no-churn + TPH codegen)**

Run: `cd server/java && mvn -q -pl codegen-spring test`
Expected: PASS — non-`@autoSet` TPH output unchanged (e.g. `TphDiscriminatorEnumConformanceTest`).

- [ ] **Step 7: Commit**

```bash
cd <repo-root>
git add server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringControllerGenerator.java \
        server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringDtoGenerator.java \
        server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/AutoSetSupport.java \
        server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringAutoSetStampingTest.java
git -c user.name="Doug Mealing" -c user.email="doug@dougmealing.com" commit -m "feat(codegen-spring): TPH per-subtype controller stamps @autoSet (ADR-0045, #203/#229)

<trailers>"
```

---

## Task 4: Cross-port gate — fixture, reference servers, seeds, scenario

This task lands the shared fixture change, makes all five reference servers + generated lanes honor `@autoSet` on the TPH path, and commits the scenario **last** (only once every lane is green). It is executed as five per-port sub-efforts (reference server + generated-lane seed) converging on one scenario, then a single green run.

**Files:** see the "Cross-port gate (Task 4)" list in File Structure above.

**Interfaces:**
- Consumes: the fixed generated TPH controllers from Tasks 1–3; the existing `fieldsNotEqual` matcher (exactly two field names) present in every port's assertion layer.
- Produces: `tph/scenarios/tph-autoset-patch.yaml`, green on all ten lanes (5 ports × 2 lanes).

- [ ] **Step 1: Add the `@autoSet` columns to the TPH base fixture**

Edit `fixtures/api-contract-conformance/tph/meta.json` — add to the `Auth` base's `children`, after `reference` and before `identity.primary`:

```json
{ "field.timestamp": { "name": "autoCreatedAt", "@autoSet": "onCreate" } },
{ "field.timestamp": { "name": "autoUpdatedAt", "@autoSet": "onUpdate" } },
```

- [ ] **Step 2: Add the sentinel to the seed rows**

Edit `fixtures/api-contract-conformance/tph/seed.json` — add both columns set to the sentinel on every row (at minimum the Bridge row `id:1`):

```json
"auths": [
  { "id": 1, "type": "Bridge",    "reference": "REF-1", "quantity": 5,    "copayAmount": null,    "approver": null,       "autoCreatedAt": "2000-01-01T00:00:00", "autoUpdatedAt": "2000-01-01T00:00:00" },
  { "id": 2, "type": "Copay",     "reference": "REF-2", "quantity": null, "copayAmount": "12.50", "approver": null,       "autoCreatedAt": "2000-01-01T00:00:00", "autoUpdatedAt": "2000-01-01T00:00:00" },
  { "id": 3, "type": "PriorAuth", "reference": "REF-3", "quantity": null, "copayAmount": null,    "approver": "Dr. Smith","autoCreatedAt": "2000-01-01T00:00:00", "autoUpdatedAt": "2000-01-01T00:00:00" }
]
```

- [ ] **Step 3: Make each reference server + generated-lane seed honor `@autoSet` (per port)**

For each of TS, C#, Java, Kotlin, Python:
- **Reference server** (`*Tph*ReferenceServer`): the per-subtype create stamps `autoCreatedAt == autoUpdatedAt = now()`; the per-subtype update bumps `autoUpdatedAt` and preserves `autoCreatedAt`. (The hand-rolled server must honor the same contract as the generated code — the gate runs both lanes.)
- **Generated-lane harness** (`TphGeneratedServerFactory.cs` / `GeneratedTphControllerHarness.{kt,java}` / `generated_tph_app.py` / `api-contract-tph-generated-server.ts`) + its in-memory/store seed: confirm the sentinel row is planted via **direct insert** from `seed.json`, NOT by replaying a create POST (a POST would re-stamp and destroy the sentinel). If any harness seeds via POST, switch it to direct insert — exactly the switch the vanilla gate made. Also confirm the store/table now carries the two new columns (in-memory row shape + generated Postgres schema pick them up automatically from the fixture; adjust any hand-written row tuple/DTO in the harness).

Verify each port's existing TPH scenarios still pass after Steps 1–2 (subset body matcher means the extra response columns don't break them):
- TS: `cd server/typescript && bun test packages/integration-tests/test/api-contract-tph.test.ts`
- C#: `cd server/csharp && dotnet test --filter ApiContractTphConformanceTest`
- Java: `cd server/java && mvn -q -pl integration-tests test -Dtest='*Tph*ApiContract*'`
- Kotlin: `cd server/java && mvn -q -pl integration-tests-kotlin test -Dtest='*Tph*ApiContract*'`
- Python: `cd server/python && uv run --extra integration pytest tests/integration/test_api_contract_tph.py tests/integration/test_api_contract_tph_generated.py -v`

Expected: PASS on all (existing scenarios unaffected; `@autoSet` not yet asserted).

- [ ] **Step 4: Add the gate scenario**

Create `fixtures/api-contract-conformance/tph/scenarios/tph-autoset-patch.yaml`:

```yaml
name: tph-autoset-patch
description: >
  #203 / ADR-0045 (TPH leg) — @autoSet stamping is honored by the deployed TPH API
  surface (generated per-subtype controller/router AND the reference server). The
  seeded Bridge row (id:1) starts with autoCreatedAt == autoUpdatedAt (both the 2000
  sentinel). A PATCH on /api/auths/bridge/1 must bump the onUpdate column
  (autoUpdatedAt) to now() while leaving the onCreate column (autoCreatedAt) at the
  sentinel — so the two diverge. Asserted as a field-vs-field inequality
  (format/timing-agnostic), catching BOTH the no-bump bug and the lost-update bug of
  rewriting createdAt on update.
requests:
  - id: r1
    method: PATCH
    path: /api/auths/bridge/1
    body:
      reference: "REF-1b"
    expect:
      status: 200
      body:
        fieldsNotEqual: [autoCreatedAt, autoUpdatedAt]
```

- [ ] **Step 5: Run all ten lanes green**

Run each port's full TPH api-contract suite (both lanes) — the new scenario is auto-discovered:
- TS: `cd server/typescript && bun test packages/integration-tests/test/api-contract-tph.test.ts`
- C#: `cd server/csharp && dotnet test --filter ApiContractTphConformanceTest`
- Java: `cd server/java && mvn -q -pl integration-tests test -Dtest='*Tph*ApiContract*'`
- Kotlin: `cd server/java && mvn -q -pl integration-tests-kotlin test -Dtest='*Tph*ApiContract*'`
- Python: `cd server/python && uv run --extra integration pytest tests/integration/test_api_contract_tph.py tests/integration/test_api_contract_tph_generated.py -v`

Expected: PASS on all five ports, both lanes. If C# or TS reds here, their TPH stamping is not as assumed — fix it (C#: extend `AppendTphSubtypeRoutes`; TS: ensure the per-subtype route parses through the subtype Insert/Update Zod schema) before proceeding.

- [ ] **Step 6: Commit the gate**

```bash
cd <repo-root>
git add fixtures/api-contract-conformance/tph/meta.json \
        fixtures/api-contract-conformance/tph/seed.json \
        fixtures/api-contract-conformance/tph/scenarios/tph-autoset-patch.yaml \
        server/typescript/packages/integration-tests/src/api-contract-tph-server.ts \
        server/typescript/packages/integration-tests/src/api-contract-tph-generated-server.ts \
        server/csharp/MetaObjects.IntegrationTests/Api/TphReferenceServer.cs \
        server/csharp/MetaObjects.IntegrationTests/Api/TphGeneratedServerFactory.cs \
        server/java/integration-tests/src/test/java/com/metaobjects/integration/api/tph \
        server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/tph \
        server/python/tests/integration/generated_tph_app.py \
        server/python/tests/integration/*tph*reference*  # adjust to the actual reference-server path
git -c user.name="Doug Mealing" -c user.email="doug@dougmealing.com" commit -m "test(api-contract): cross-port TPH @autoSet stamping gate (ADR-0045, #203/#229)

<trailers>"
```

---

## Task 5: Review, simplify, merge forward

The vanilla `@autoSet` legs skipped code-reviewer/simplifier for context budget. Do not skip here.

- [ ] **Step 1: Per-unit code review** — run the code-reviewer agent over each of the four generator diffs (Kotlin, Python, Java, the gate). Address findings (fix or justify).
- [ ] **Step 2: Per-unit simplify** — run the code-simplifier agent over the same diffs; apply quality fixes that don't change behavior.
- [ ] **Step 3: Affected-port CI** — `bash scripts/ci-local.sh --only kotlin --strict-toolchains`, `--only python`, `--only java`; TS via the pre-push gate. Expected: green.
- [ ] **Step 4: Confirm forward-only** — `git status` clean, `git log --oneline origin/main..HEAD` shows the four commits + any review fixups; do not rebase/reset `main`.
- [ ] **Step 5: Report** — summarize what shipped (three generated-controller fixes + the cross-port gate), which ports were fix vs verify, and the deferred item (TPH + `@autoSet` + write-through, and TPH multi-level, remain out of scope). Do not release (this rides the next coordinated release).

---

## Self-Review

**Spec coverage:**
- Gate (fixture + seed + scenario) → Task 4 Steps 1–2, 4. ✓
- Java/Kotlin/Python generated-controller fixes → Tasks 3, 1, 2. ✓
- Settable-set SSOT `@autoSet` exclusion (Kotlin/Java/Python) → Task 1 Step 3, Task 3 Step 3, Task 2 (via the create/patch models). ✓
- Reference servers + direct-insert seeds (all 5) → Task 4 Step 3. ✓
- C#/TS verify (with fix fallback) → Task 4 Step 5. ✓
- No-churn guarantee → Tasks 1/2/3 Step 6 + the "byte-identical" unit test in each. ✓
- Review + simplify (not skipped) → Task 5. ✓
- Verification order (fixes → reference servers/seeds → scenario last) → Task ordering + Task 4 internal ordering. ✓

**Placeholder scan:** the one deliberate placeholder is `<trailers>` in commit messages (expand to the standard `Co-Authored-By:` + `Claude-Session:` trailers) and the "adjust to the actual reference-server path" note in Task 4 Step 6 (the Python tph reference-server filename must be confirmed at execution — `ls server/python/tests/integration | grep tph`). No `TODO`/`TBD`/"handle edge cases".

**Type/name consistency:** `autoCreatedAt`/`autoUpdatedAt` + `"2000-01-01T00:00:00"` used identically across Tasks 1–4; helper names (`isAutoSetField`/`autoSetPolicy`/`nowExpr`; `_auto_set_split`/`_auto_set_stamp_lines`; `AutoSetSupport.hasAutoSetFields`/`hasOnUpdateFields`/`stampForInsert`/`stampAutoSetOnUpdate`) match the source verified 2026-07-23.
