# Plan: `MetaObjectSerializer` DATE recursion fix (#275) + Java object-JSON layer docs (#273)

**Date:** 2026-08-08 · **Baseline:** `main` @ `5e4e50df` (clean; `0.21.0` / `7.21.0` shipped to all four registries)
**Executes from:** this file alone. The authoring session's context is gone — every premise below was
verified at the baseline SHA but must be **re-derived from code** before acting on it (see Meta-lesson).
**Issues:** #275 (latent `StackOverflowError` — the fix), #273 (doc gap — gated on #275's fix).
**Prior investigation (do not redo):** `.superpowers/sdd/2026-08-06-projection-payload-vocab-batch/issue-273-scope.md`
— #273 is **Java-only**; the issue's suggested fix #2 is **inverted** (`pojoAware` emits the *breaking*
`extends PojoObject` shape; the clean-Jackson answer is the `codegen-spring` record surface); there are
**two** producing paths for MetaObjectAware instances (codegen-base flavored objects AND the om/omdb runtime).

---

## STATUS — update as you go (edit this file, commit the checkbox flips with the work)

- [ ] Phase 0 — setup, premise recon
- [ ] Unit A — wire-form implementation: serializer DATE branch + deserializer DATE split + streaming-reader split + `TemporalWireFormat` + gate tests (TDD)
- [ ] Unit B — Gson wiring siblings: `JsonObjectReader` registers serializers-only; initializer's add-flags are dead code (fix TOGETHER — they mask each other)
- [ ] Unit C — serializer write-side `@isArray` asymmetry (bounded; **maintainer checkpoint before widening**)
- [ ] Unit D — #273 docs (5 files; gated on Unit A being merged-or-on-the-same-branch)
- [ ] Free-text sweep (hazard discipline — member VALUES, spelling-agnostic)
- [ ] Independent review (branch + `no-mistakes` gate) → merge to `main` → local-ci green
- [ ] Release — coordinated PATCH: npm `0.21.1` · PyPI `0.21.1` · NuGet `0.21.1` · Maven `7.21.1` (**checkpoint with the maintainer first**)
- [ ] Close #275 + #273 with receipts

---

## Meta-lesson (read before every unit)

Recent issues in this repo (#270, #271) had premises falsified by recon within hours. Every anchor
below was verified at `5e4e50df` on 2026-08-08; `main` may have moved. **Each unit opens with a
premise-recon block — run it.** If a premise fails (file moved, behavior already fixed, an anchor
doesn't match), STOP that unit and report to the maintainer. Before any implementation:
`git log --oneline --grep '#275\|#273'` (was empty at baseline) and re-read the target code.

**Tooling hazard 1 (caused a real mis-ruling here):** `grep` in this environment is a shell function
that passes `-I` and skips binary-looking files **silently** (no output, exit 1). Use `git grep` or
`command grep` for every load-bearing search, and treat empty output from a command that must print
something as a broken command, never a negative result.

**Tooling hazard 2:** after establishing a rule, sweep for member **values as free text,
spelling-agnostically** — not just constant names or the dotted form (a sweep matching
`origin.aggregate` once missed a file writing `aggregate` bare, and it shipped).

---

## House rules (binding)

- **Git:** `main` is forward-only (merge/FF only). Stage **explicit paths** — never `git add -A`.
  Work on a **short-lived branch**; the `no-mistakes` gate cannot validate work already on `main`.
- **TDD:** failing test first, then implementation.
- **Fix in place:** a bug found mid-flight is work to DO in this batch — never `gh issue create` a
  follow-up unless the maintainer asks. (Unit C exists because of this rule; its checkpoint bounds it.)
- **Public repo hygiene:** no private project names, no home paths, in any committed file or message.
- **Java builds:** never `mvn -T` (deadlock history). Maven >10 min is not a failure.
- **Never run a bare `bun test` at the repo root.** Scope to a package.
- **ADR-0039:** read attrs via resolving accessors (`hasMetaAttr`/`getMetaAttr`), never `own*()`.

---

## The wire-form ruling (derived — do not re-open without new evidence)

### What is broken (verified at baseline)

`server/java/metadata/src/main/java/com/metaobjects/io/object/gson/MetaObjectSerializer.java` L76-78:

```java
case DATE:      // TODO: consider custom DATE serialization
    jsonObject.add(name, context.serialize(vo));
```

Every sibling branch extracts the field value via `mf.getX(vo)`; DATE alone hands back `vo` — the
containing object. `MetaObjectGsonInitializer` (same package) registers this serializer against the
VO's own class/interface, so `context.serialize(vo)` re-dispatches to the same serializer with the
same instance → unbounded recursion → `StackOverflowError` (an `Error`, uncatchable by the usual
`catch (Exception …)` around a best-effort write). **The branch fires even when the date value is
`null`** — it never reads the value at all.

**Blast radius is wider than the issue states:** `TimestampField` is **also `DataTypes.DATE`**
(`TimestampField.java` L89: `super(SUBTYPE_TIMESTAMP, name, DataTypes.DATE)`), so `field.timestamp`
crashes too, and **OMDB's typed-jsonb codec serializes jsonb VO column values through this very
serializer** (`server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/GenericSQLDriver.java`
L100-123, `buildGson(...)` → `MetaObjectGsonInitializer.getBuilderWithAdapters`) — a
`field.object @storage: jsonb` VO declaring any date/timestamp field crashes an OMDB INSERT/UPDATE.
It never fired in the conformance corpus only because the `AllTypes` jsonb VO (`labels`) is
`{key: string, weight: int}` — no temporal.

### The evidence trail (the four questions, answered)

1. **What the other four ports put on the wire** — the cross-port serialization-boundary contract is
   `fixtures/persistence-conformance/normalization.md` ("the single source of truth"), per-type table
   L27-43 + the millisecond/omit-zero-fraction rule L45-69, exercised by every port in
   `fixtures/persistence-conformance/queries/roundtrip-all-types.yaml` (L69-96: `dateVal: "2026-06-03"`,
   `timeVal: "14:30:00.123"`, `tsVal: "2026-06-03T14:30:00.123"` no-Z for `@localTime`,
   `tsTzVal: "2026-06-03T14:30:00.123Z"` for the tz-aware default). **ISO-8601 strings, never epoch
   numbers.** (`spec/wire-format.md` is the *metadata file* format — not relevant.)
2. **Existing documented canonical form** — yes, the table above: DATE `"YYYY-MM-DD"`; TIMESTAMP
   `"YYYY-MM-DDTHH:MM:SS[.fff]"` (no Z); TIMESTAMPTZ `"…Z"` (UTC always); fraction at ms resolution,
   trailing zeros stripped, the whole fraction omitted when zero. The Gson path is simply failing to
   honor it — and ADR-0019 places wire canonicalization exactly at serialization boundaries like this one.
3. **Is `JsonObjectWriter`/`JsonObjectReader` a correct reference?** **No — there is no working write
   form to preserve.** `JsonObjectWriter.write` delegates to this same broken serializer, and its static
   `writeObject` helper calls `setDefaultDateFormat()` = Gson `setDateFormat(DateFormat.FULL, FULL)` —
   **locale-dependent** (`JsonMetaDataWriter.java` L48-49), evidence the branch was never finished. The
   only *working* temporal form in the layer is the **read** half: `MetaObjectDeserializer` L110-119
   groups `case DATE:` with `LONG` (`el.getAsLong()` → `setLong` → `DataConverter.toDate(Long)` = epoch
   millis), and the (internally-unreachable) streaming `JsonObjectReader.readFieldValue` L159-160 agrees.
   So: **no data with temporal fields has ever been written by this layer** (every attempt crashed);
   hand-produced epoch-long JSON targeting the read half MAY exist in the wild.
4. **Must `@localTime` survive?** Yes — the canonical contract discriminates the two timestamp flavors
   by the `Z` suffix ("never elide it for TZ and never add it for plain timestamp"), and the Java port
   already implements precisely this mapping for the same value classes in
   `server/java/integration-tests/src/test/java/com/metaobjects/integration/Normalization.java` L62-92
   (instant-anchored `java.util.Date`/`Timestamp` → wall clock recovered at UTC; date → calendar date
   at UTC). `TimestampField.ATTR_LOCAL_TIME` exists (L57) and is readable via resolving accessors.

### The ruling

**Write** (serializer `case DATE:`, which serves both `field.date` and `field.timestamp`):
extract the value with `mf.getDate(vo)` (exists — `MetaField.java` L1161), then format by the
field's **subtype** (resolving accessor):

| field | wire form | example |
|---|---|---|
| `field.date` | calendar date of the instant at UTC — `"YYYY-MM-DD"` | `"2026-06-03"` |
| `field.timestamp` + `@localTime: true` | wall clock of the instant at UTC, no Z — `"YYYY-MM-DDTHH:MM:SS[.fff]"` | `"2026-06-03T14:30:00.123"` |
| `field.timestamp` (default, tz-aware) | UTC instant — `"YYYY-MM-DDTHH:MM:SS[.fff]Z"` | `"2026-06-03T14:30:00.123Z"` |
| any other `DataTypes.DATE` carrier (none exist today) | the instant form with Z | |

Fraction rule identical to the canonical contract: millisecond resolution, strip trailing zeros,
omit the `.` and fraction entirely when zero (`.123`→`.123`, `.120`→`.12`, `.100`→`.1`, `.000`→omitted).
`null` value → JSON `null`.

**Read** (`case DATE:` splits off `LONG` in BOTH readers):
- JSON **number** → epoch millis → `Date` (**legacy compatibility — keeps every possible existing
  reader/producer working; this is what makes the release a PATCH**).
- JSON **string** → tolerant ISO parse, tried in order: `Instant.parse` (Z form) → `LocalDateTime`
  at UTC (no-Z form) → `LocalDate` at midnight UTC (date-only form). Failure → a clear parse error
  naming the field and the accepted forms.
- `case LONG:` keeps its own branch, unchanged.

**Why ISO and not the epoch-long the read half already speaks:** (a) the write side never worked, so
epoch has no deployed-writer constituency to protect while ISO has the entire rest of the ecosystem;
(b) this serializer's output **lands in OMDB jsonb columns** — epoch longs there would diverge from
what every other port's jsonb codec stores (ISO strings) the day the corpus gains a jsonb temporal;
(c) #273 is about to *document* this layer as the sanctioned path — documenting a locale/epoch wart
is worse than aligning it; (d) the read half keeps accepting epoch numbers, so nothing deployed breaks.

**Known bounded caveat (state it in the docs, do not "fix" it):** a hand-constructed `DateField`
value carrying a sub-day component writes as the calendar date (truncation on first write; stable
thereafter). This matches the shipped OMDB DATE codec, which anchors DATE columns at midnight UTC
(`Normalization.java` L88-91 comment). The `@localTime` flag itself survives via the Z/no-Z
discrimination, exactly as the canonical contract requires.

---

## Sibling-defect census (the "only defect of its kind?" answer — verified at baseline)

In `MetaObjectSerializer.writeField` and its symmetric readers:

| site | verdict |
|---|---|
| `case DATE:` serializer L76-78 | **THE bug** (both `field.date` and `field.timestamp`) — Unit A |
| `case CUSTOM:` → `writeFieldCustom(… vo …)` | **NOT a bug.** The handler contract takes the *containing object*: `PrimitiveField implements StringSerializationHandler` reads the field itself via `getObjectAttribute(o)` (`PrimitiveField.java` L7, L16-17). `field.time` (`DataTypes.CUSTOM`, `TimeField.java` L76) serializes correctly through it. |
| every other branch | correct — `mf.getX(vo)` accessors throughout |
| **write-side `@isArray` asymmetry** | **sibling defect** — the deserializer has universal `mf.isArrayType()` support (L90-118 etc.); the serializer has NONE, so an array-valued primitive field writes through `DataConverter.toString(List)` = **comma-join** (`DataConverter.java` L598-603): `["a","b"]` read in, written back as `"a,b"` — silent round-trip corruption. Unit C. |
| `MetaObjectGsonInitializer` L62-75 | **wiring sibling** — the `addSerializer`/`addDeserializer` flags are honored for interface registrations (L51-56) but **commented out** for both class-registration sites, so `addSerializersToBuilder`/`addDeserializersToBuilder` register both anyway. Unit B. |
| `JsonObjectReader.read` L45 | **wiring sibling** — calls `addSerializersToBuilder` (should be deserializers). Currently masked by the dead flags above for concrete classes; NOT masked for interface-classed objects (a reader there gets only a serializer). **Must be fixed in the same commit as the flags** — restoring the flags alone would break the reader. Unit B. |
| deserializer array reads via `context.deserialize(el, List.class)` | pre-existing wart (Gson yields `List<Double>` for numeric arrays — precision/type loss). Recorded; **checkpoint at Unit C, default = leave** except DATE arrays, which Unit A/C parse element-wise. |
| `MetaObjectSerializer.serialize` NPE when `mo == null` and object not `MetaObjectAware` | micro-robustness; note only, out of scope. |
| `DATE_ARRAY` DataType | registration-only, no field class constructs with it (verified: only `DataTypes.java` + a commented `DataConverter` line). No serializer case needed. |

**Cross-port re-entry sweep (probably-not, checked anyway): CLEAN.** Kotlin codegen emits no custom
Jackson serializers (no `StdSerializer`/`addSerializer` in `codegen-kotlin/src/main`); C#'s
`SerializerJson.cs` is the canonical *metadata* serializer (not object IO) and no `MetaObjectSerializer`
analogue exists in `server/csharp`; Python/TS ship no custom encoder layer (TS `ValueObject` has a
`toObject()` escape hatch, off all shipped paths). Concurs with the #273 scope investigation.

---

## Sequencing and release shape (decided — re-open only at the named checkpoints)

**One branch, one PR, one coordinated release.** Units A → B → C → D in order (A first: it is the
gate for D and the biggest risk; B is two small wiring fixes that must land atomically; C is bounded
by a checkpoint; D documents whatever A shipped).

| Release | Version | Contents | Product code | Why PATCH |
|---|---|---|---|---|
| this batch | npm `0.21.1` · PyPI `0.21.1` · NuGet `0.21.1` · Maven **`7.21.1`** — coordinated PATCH | Units A-D | **Maven** (`metadata` module) + **npm** (`@metaobjectsdev/sdk` bundles `agent-context/` — verified: `sdk/package.json` `files` includes `agent-context`, build runs `bundle-agent-context.mjs`) | Per `docs/RELEASING.md`: the write path **never worked** (crashed), so this is "wrong output corrected" (PATCH row); the read path stays backward-compatible (epoch numbers still accepted), so no already-valid deployment changes behavior. PyPI + NuGet are **version-parity bumps** (single-shared-patch policy, standing since `0.20.13`). |

**Checkpoint:** confirm the PATCH call and the cut timing with the maintainer before releasing
(pre-1.0 `^0.21.x` auto-adopts a patch — that is *desired* here: it only un-breaks).

---

## Phase 0 — setup and premise recon

```bash
cd <repo-root>
git fetch origin && git log --oneline -3 origin/main    # at/after 5e4e50df; origin/main is ground truth
git status --short                                      # must be clean
git config core.hooksPath                               # expect .githooks
git log --oneline --grep '#275\|#273'                   # was EMPTY at baseline — if not, read what landed first
git checkout -b fix/serializer-date-recursion-and-json-docs
```

Read both issues (`gh issue view 275 273` or the REST API if `gh` auth is stale) and the scope doc
`.superpowers/sdd/2026-08-06-projection-payload-vocab-batch/issue-273-scope.md`.

---

## Unit A — the DATE fix (serializer + both readers + `TemporalWireFormat`)

### A.0 Premise recon (stop if any fails)

```bash
git grep -n "case DATE" server/java/metadata/src/main/java/com/metaobjects/io/object/gson/MetaObjectSerializer.java
#   expect L76-78: context.serialize(vo)
git grep -n "case DATE" server/java/metadata/src/main/java/com/metaobjects/io/object/gson/MetaObjectDeserializer.java
#   expect L110-111: grouped with LONG
git grep -n "case DATE" server/java/metadata/src/main/java/com/metaobjects/io/object/json/JsonObjectReader.java
#   expect L159-160: grouped with LONG, in().nextLong()
git grep -n "DataTypes.DATE" server/java/metadata/src/main/java/com/metaobjects/field/DateField.java server/java/metadata/src/main/java/com/metaobjects/field/TimestampField.java
#   expect BOTH (DateField L47, TimestampField L89)
git grep -n "setDefaultDateFormat" server/java/metadata/src/main/java/com/metaobjects/io/object/json/JsonObjectWriter.java
#   expect L26 (the locale-dependent call to delete)
git grep -n "MetaObjectGsonInitializer" server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/GenericSQLDriver.java
#   expect the jsonb codec dependency (~L100-123) — OMDB is downstream of this fix
git grep -n "pickedDate" server/java/metadata/src/test/resources/com/metaobjects/loader/simple/fruitbasket-proxy-metadata.json
#   expect Orange.pickedDate field.date (~L257) — the ready-made crash fixture
git grep -n "getPickedDate" server/java/metadata/src/test/java/com/metaobjects/test/proxy/fruitbasket/Orange.java
#   expect the proxy accessor pair
```

### A.1 TDD order

1. **RED — the crash pin.** New test class
   `server/java/metadata/src/test/java/com/metaobjects/io/object/gson/GsonTemporalRoundTripTest.java`
   (JUnit 4, mirror `GsonAdapterTest`'s loader setup): serialize an `Orange` via
   `MetaObjectGsonInitializer.getBuilderWithAdapters(loader).create().toJson(orange)` with
   `pickedDate` **set** — currently dies with `StackOverflowError`. Also pin the **null-date** case
   (recurses today too — the branch never reads the value).
2. **RED — timestamp + `@localTime` coverage.** The fruitbasket fixture has no `field.timestamp`;
   add a small test-only metadata resource
   `server/java/metadata/src/test/resources/com/metaobjects/io/object/gson/temporal-metadata.json`
   declaring one ValueObject-backed object with `field.date`, plain `field.timestamp`, and
   `field.timestamp @localTime: true` (no proxy class needed — follow the `ObjectIOTestBase`
   ValueObject pattern; do NOT edit the shared fruitbasket fixtures). Assert the exact wire strings
   per the ruling table, including the fraction vectors: `.123` kept, `.120`→`.12`, `.000` omitted.
3. **RED — legacy epoch read.** Hand-authored JSON `{"@type":"…","pickedDate":1750000000000}`
   deserializes to the right `Date` (number path preserved).
4. **RED — tolerant ISO read.** Each of the three written forms parses back; a garbage string fails
   with an error naming the field.
5. **GREEN — implement** (A.2).
6. **Round-trip + no-churn pins:** write→read→write is byte-identical on pass 2; `Apple` (no
   temporal fields) serializes **byte-identically to before the change** (pin the exact string);
   existing `GsonAdapterTest` + `ObjectIOTest*` untouched and green.

### A.2 Change spec

New package-level helper `server/java/metadata/src/main/java/com/metaobjects/io/json/TemporalWireFormat.java`
(shared by serializer, Gson deserializer, and streaming reader — one implementation, not three):

- `static String format(MetaField mf, java.util.Date d)` — dispatch on the field **subtype**
  (`mf.getSubType()` — compare against `DateField.SUBTYPE_DATE` / `TimestampField.SUBTYPE_TIMESTAMP`
  constants, never literals) and, for timestamp, the resolving-accessor read of
  `TimestampField.ATTR_LOCAL_TIME` (`hasMetaAttr`/`getMetaAttr` — ADR-0039; a comment is NOT needed,
  this is the default accessor). All conversion at `ZoneOffset.UTC` from `Instant.ofEpochMilli(d.getTime())`.
  Fraction: ms resolution, strip trailing zeros, omit-when-zero (mirror the shapes in
  `integration-tests/.../Normalization.java` L62-92 — but implement locally; the `metadata` module
  cannot depend on a test module).
- `static java.util.Date parse(String s)` — `Instant.parse` → `LocalDateTime.parse` at UTC →
  `LocalDate.parse` at midnight UTC, else throw with the accepted-forms message.

`MetaObjectSerializer.writeField`:

```java
case DATE: {
    java.util.Date d = mf.getDate(vo);
    if (d == null) jsonObject.add(name, JsonNull.INSTANCE);
    else jsonObject.addProperty(name, TemporalWireFormat.format(mf, d));
    break;
}
```

`MetaObjectDeserializer.readFieldValue` — split `case DATE:` from `case LONG:` (LONG unchanged):
number → `mf.setLong(vo, el.getAsLong())` (existing coercion path); string →
`mf.setDate(vo, TemporalWireFormat.parse(el.getAsString()))`; `isArrayType()` + JsonArray →
element-wise through the same number/string logic into a `List<java.util.Date>` (do NOT keep the raw
`context.deserialize(el, List.class)` for DATE — it yields `List<Double>`).

`JsonObjectReader.readFieldValue` (streaming; unreachable from the public `read()` today but
protected/subclassable — keep it honest): split `case DATE:`; `in().peek() == NUMBER` → `nextLong`,
`STRING` → `TemporalWireFormat.parse(nextString())`.

`JsonObjectWriter.writeObject` (static helper): **delete the `writer.setDefaultDateFormat()` call**
(L26). With DATE explicit, that locale-dependent `DateFormat.FULL` setting can only ever produce a
*second*, locale-dependent date form on some stray non-MetaField path. Leave the protected method on
`JsonMetaDataWriter` itself (public-ish surface; unused otherwise — verified only this one caller).

### A.3 Byte-identical / no-churn requirements

- Any VO with **no** temporal field: wire output byte-identical (pinned in A.1 step 6).
- OMDB jsonb payloads for non-temporal VOs: byte-identical (no omdb code change; its Gson comes from
  the initializer). `mvn -q -pl omdb test` must stay green untouched.
- No codegen change anywhere; `meta gen` output untouched by construction.

### A.4 Stop-and-escalate

- Any evidence of a deployed *writer* of temporal fields through this layer (should be impossible —
  it crashed) → stop, re-derive the compat story.
- `TimestampField`'s `@localTime` not readable at this layer for some reason → fall back to the
  two-form ruling (date / instant-Z) and record the deviation here + in the issue.
- The temptation to add a temporal field to the shared persistence-conformance `labels` VO to gate
  jsonb temporals **cross-port**: that is five-port scope — do NOT do it in this batch; raise it at
  the release checkpoint as a candidate follow-up for the maintainer to direct.

---

## Unit B — Gson wiring siblings (atomic pair)

### B.0 Premise recon

```bash
git grep -n "addSerializersToBuilder" server/java/metadata/src/main/java/com/metaobjects/io/object/json/JsonObjectReader.java
#   expect L45 — the READER registering serializers
git grep -n "//if (addSerializer)\|//if (addDeserializer)" server/java/metadata/src/main/java/com/metaobjects/io/object/gson/MetaObjectGsonInitializer.java
#   expect the commented-out flag checks at both class-registration sites (~L62-75)
```

### B.1 Change spec (one commit — they mask each other)

- `JsonObjectReader.read(MetaObject)`: `addSerializersToBuilder` → `addDeserializersToBuilder`.
- `MetaObjectGsonInitializer.addAdaptersToBuilder`: restore the `addSerializer`/`addDeserializer`
  flag honoring at both class-registration sites (the interface site already honors them).

**Ordering hazard (the reason for atomicity):** restoring the flags while the reader still asks for
serializers leaves the reader with NO deserializer → Gson falls back to reflective construction of
`PojoObject`/proxy types → breakage. Fixing the reader first is safe; land both together anyway.

### B.2 TDD

1. RED: a builder from `addDeserializersToBuilder` alone `fromJson`s the Unit-A wire form correctly
   (fails before the reader fix only via the interface path; passes trivially after — the load-bearing
   assertion is the next one).
2. RED after flag-restore-only (proves the mask): `JsonObjectReader` round-trip. Then apply the
   reader fix in the same commit; green.
3. No-churn: `JsonObjectWriter` output byte-identical (`addSerializersToBuilder` still registers
   serializers); `GsonAdapterTest` (uses `getBuilderWithAdapters` = both) untouched.

### B.3 Stop-and-escalate

If restoring the flags reddens any existing test in a way that suggests an intentional
register-both dependency elsewhere, stop — report; the fallback is reader-fix-only + deleting the
misleading split methods' flag parameters is NOT allowed (public surface). Record whatever is chosen.

---

## Unit C — serializer write-side `@isArray` asymmetry (bounded)

### C.0 Premise recon

```bash
git grep -n "isArrayType" server/java/metadata/src/main/java/com/metaobjects/io/object/gson/MetaObjectSerializer.java   # expect: NO hits
git grep -n "isArrayType" server/java/metadata/src/main/java/com/metaobjects/io/object/gson/MetaObjectDeserializer.java # expect: many
git grep -n -A5 "public static String toString" server/java/metadata/src/main/java/com/metaobjects/util/DataConverter.java  # expect comma-join List branch (~L598)
```

### C.1 Scope (default — confirm at the checkpoint before starting)

In `writeField`, for `mf.isArrayType()` on the primitive branches (BOOLEAN / BYTE / SHORT / INT /
LONG / FLOAT / DOUBLE / STRING): serialize the raw list value (`context.serialize(mf.getObject(vo))`
— Gson handles `List<String>`/`List<Number>` natively) instead of falling into the scalar accessor
comma-join. DATE arrays: element-wise `TemporalWireFormat.format`. DECIMAL: reader declares "no
array form" — leave symmetric (scalar only). **Out of scope by default** (record, don't fix): the
deserializer's numeric-array `List<Double>` widening. TDD: RED round-trip of a `List<String>`-valued
`@isArray` field (today: written `"a,b"`), then GREEN, then no-churn pin on scalar fields.

### C.2 Stop-and-escalate

If this unit grows beyond `writeField` + `TemporalWireFormat` element formatting (e.g. it starts
pulling `DataConverter` array conversions into scope), STOP and present the census line to the
maintainer; ship Units A/B/D without C rather than balloon.

---

## Unit D — #273 docs (gated: describes ONLY behavior shipped by Units A/B on this branch)

### D.0 Premise recon (anchors verified 2026-08-08; scope-doc verdicts assumed, not re-derived)

```bash
command grep -n "SpringControllerGenerator" agent-context/skills/metaobjects-codegen/references/java.md   # generator table ~L96-107, Spring-only
command grep -n "ValueObject" agent-context/skills/metaobjects-runtime-ui/references/java.md | head -3    # "Objects are ValueObject instances" ~L33
command grep -n "## Principles" agent-context/templates/always-on.md.mustache                             # ~L11; template is STACK-NEUTRAL
command grep -n "## Generators" docs/ports/java.md                                                        # ~L260
git grep -rn "MetaObjectSerializer\|JsonObjectWriter" docs/ports/ agent-context/                          # expect: NO hits (the gap)
```

### D.1 The five edits (from the scope doc, updated with the Unit-A ruling)

1. **`agent-context/skills/metaobjects-codegen/references/java.md`** — new "Serializing generated
   objects" section + add `JavaObjectCodeGenerator` (module `metaobjects-codegen-base`) to the
   generator table with BOTH flavors: `pojoAware` → `extends PojoObject` (**the breaking-for-default-
   Jackson shape** — the issue's fix #2 had this inverted), `valueObject` → map-backed `ValueObject`.
2. **`agent-context/skills/metaobjects-prompts/references/java.md`** — one paragraph: codegen-spring
   `extractLenient` returns plain records (safe with any mapper); the codegen-base flavored
   `<Name>Extractor` / raw `MetaObjectExtractor` return MetaObjectAware instances → serialize via
   `JsonObjectWriter`/`MetaObjectSerializer`.
3. **`agent-context/skills/metaobjects-runtime-ui/references/java.md`** — after the "rows are
   `ValueObject` instances" passage: how to JSON an OMDB-returned object. Softener: Java `ValueObject`
   is a `Map`, so Jackson map-serializes it; the hard failure is the **pojoAware bean shape** (public
   `getMetaData()` → JPMS `InaccessibleObjectException`) and any direct Gson field walk.
4. **`agent-context/templates/always-on.md.mustache`** — ONE principle line, **"JVM:"-prefixed**
   (the template is stack-neutral and scaffolds every stack): serialize MetaObject-backed instances
   through the MetaObjects JSON layer; never hand-configure a mapper around the framework fields.
   If this drifts toward per-language template conditionals → stop, escalate (scope-doc flag).
5. **`docs/ports/java.md`** — generator-table addition + a serialization section mirroring (1).

**Content requirements for the serialization sections:** a write+read snippet
(`JsonObjectWriter.writeObject` / `JsonObjectReader` — the read half in the SAME snippet); the wire
form as ruled (ISO per the table above; readers also accept legacy epoch-millis numbers); the
explicit sentence "a default Jackson/Gson mapper over a `PojoObject` subtype fails on the
`MetaObject` back-reference — this is expected, not a bug to work around"; the clean-default-Jackson
alternative is the **codegen-spring record surface** (never pojoAware); BOTH producing paths named
(flavored codegen AND om/omdb `getObjects`/`newInstance`). **No per-port equivalents** — the gap is
Java-only (scope doc; TS/C#/Python map to plain shapes per ADR-0019, Kotlin's nuances already
documented). The issue's fix #4 (a verify/audit check) is out of scope — say so when closing #273.

**Skill-editing hazard:** keep YAML front-matter valid (four skills once shipped broken front-matter
and never intent-triggered) — `cd server/typescript/packages/sdk && bun test` gates it.

---

## Free-text sweep (before review)

Per hazard 2 — after the ruling, sweep VALUES spelling-agnostically and READ the hits:

```bash
git grep -rni "epoch" docs/ agent-context/ spec/ | command grep -vi "epoch millis are also accepted"   # no doc may claim this layer speaks epoch-only
git grep -rn "setDefaultDateFormat\|DateFormat.FULL" server/java/                                       # only the (kept, uncalled) JsonMetaData{Reader,Writer} methods remain
git grep -rni "MetaObjectSerializer\|JsonObjectWriter\|MetaObjectAware\|PojoObject" docs/ agent-context/ CLAUDE.md
#   read every hit: each must match the shipped post-fix behavior (RELEASE_NOTES.md history entries exempt)
git grep -rn "case DATE" server/java/                                                                   # every remaining site is deliberate (DataConverter, codegen-base JavaCodeWriter …) — read each
```

---

## Gates (verbatim)

```bash
# Java (the product fix) — never -T
cd server/java && mvn -q -pl metadata test
cd server/java && mvn -q -pl omdb,om test          # downstream of the Gson layer (jsonb codec)
cd server/java && mvn -q test                       # full reactor before PR (serial; >10 min is normal)

# skills/docs (npm sdk bundles agent-context)
cd server/typescript/packages/sdk && bun test

# repo gates
scripts/ci-local.sh --quick                         # leak-scan before opening the PR
scripts/ci-local.sh --only java --strict-toolchains # the real Java lane (self-hosted parity)
# then: no-mistakes gate on the branch (rich --intent), independent review, merge (no rebase),
# and after push to main: gh run list --workflow local-ci.yml --limit 3 && gh run watch <id>
```

---

## Release

Coordinated PATCH, all four registries (single-shared-patch policy): **npm `0.21.1` · PyPI `0.21.1` ·
NuGet `0.21.1` · Maven `7.21.1`**. Changed product: Maven (`metadata` module) + npm (`sdk`
agent-context bundle). PyPI + NuGet: version-parity bumps. `CHANGELOG.md` entry covering: the #275
recursion fix + the ruled wire form (with the legacy-epoch read note), the Unit B wiring fixes, Unit
C if shipped, and the #273 docs. Follow `docs/RELEASING.md` mechanics (bun publish, lockfile regen,
Maven Central portal verification — never re-run a slow deploy). **Checkpoint with the maintainer
before cutting.** Close #275 and #273 with receipts (commits, wire-form table, what was deliberately
out of scope: the verify/audit check idea, the numeric-array read widening, the cross-port jsonb
temporal corpus gap).
