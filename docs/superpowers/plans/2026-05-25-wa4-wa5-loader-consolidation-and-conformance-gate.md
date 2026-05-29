# WA4+WA5 — Java Loader Consolidation + Conformance Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse Java's two-module `metadata`+`core` split into a single `metadata` module by moving the file-IO loader into `metadata`, deleting legacy XML I/O, converting the remaining XML fixtures to canonical JSON, and deleting the `core` module — then verify (WA5) the aligned vocabulary (`object.entity`/`value`, `source.rdb` + `@kind`/`@role`, `origin.*`) loads + canonical-round-trips on the shared conformance corpus.

**Architecture:** Move 5 file-IO classes (FQNs preserved at `com.metaobjects.loader.file.*`) + `CoreTypeInitializer` + `IOMetaDataProvider` from `core` → `metadata`. Delete 7 legacy XML I/O classes + any tests that depend on them. Write a one-shot XML→canonical-JSON converter for 4 metadata XML fixtures + update the tests that load them. Re-point 6 module poms from `metaobjects-core` → `metaobjects-metadata`. Delete the `core` module. WA5 = verification + ledger audit.

**Tech Stack:** Java 21, Maven (multi-module reactor under `server/java/`), JUnit4, the existing parameterized `ConformanceTest` + `conformance-expected-failures.json` ledger as the cross-language gate.

**Spec:** `docs/superpowers/specs/2026-05-23-java-standard-alignment-and-loader-consolidation-design.md` §73-89 (WA4 + WA5).

**Branch:** `worktree-wa4-loader-consolidation` (already created in `.claude/worktrees/wa2-entity-value-representation/`, based off `main` at `8faad2a`). Integrate via forward-merge to `main`; never rewrite `main`.

**Public-repo hygiene:** generic examples only (`acme::commerce`, `Program`); `com.metaobjects.*` is the project's own package (fine); legacy `com.draagon.*` paths in test resources are fine. No private names, no home paths in any committed file.

**Known-green baseline (pre-WA4):** `mvn -o test` per module = metadata 614/0/0, core 15/0/0, dynamic 17/0/0, om 5/0/0 (1 skip), omdb 30/0/0, codegen-base 23/0/0, codegen-mustache 33/0/0, codegen-plantuml 7/0/0, maven-plugin 8/0/0. ConformanceTest 168/0/0. Ledger: 30 entries (all honest known-gaps). After WA4 the same pass-counts (sans `core`) must hold.

**Confirmed inventory** (from pre-plan recon):
- `core/src/main` has 14 .java files (`find server/java/core/src/main -name '*.java' | wc -l` → 14).
- **5 file-IO to MOVE**: `FileMetaDataLoader.java`, `FileLoaderOptions.java`, `FileMetaDataSources.java`, `LocalFileMetaDataSources.java`, `URIFileMetaDataSources.java` (under `com/metaobjects/loader/file/`).
- **7 XML I/O to DELETE**: `XMLMetaDataReader.java`, `XMLMetaDataWriter.java`, `XMLIOUtil.java`, `XMLIOConstants.java`, `XMLSerializationHandler.java`, `XMLObjectReader.java`, `XMLObjectWriter.java` (under `com/metaobjects/io/xml/` + `com/metaobjects/io/object/xml/`).
- **1 `CoreTypeInitializer.java`** to MOVE (under `com/metaobjects/registry/`).
- **1 `IOMetaDataProvider.java`** to MOVE (likely empty per spec; verify in Task 4).
- **4 metadata XML fixtures to CONVERT**:
  - `codegen-base/src/test/resources/schema-validation/invalid-subtypes.xml`
  - `codegen-base/src/test/resources/schema-validation/invalid-missing-required.xml`
  - `codegen-base/src/test/resources/schema-validation/invalid-naming-pattern.xml`
  - `om/src/test/resources/testdata/produce/v1/Apple.xml`
  - (Excluded: `logback-test.xml`, `pom.xml`, archetype descriptors — these are NOT metadata.)
- **6 module poms to RE-POINT**: `omdb`, `dynamic`, `omdb-ktx`, `maven-plugin`, `core-spring`, `om`.
- **`core` module entry** at `server/java/pom.xml:41` (`<module>core</module>` between `maven-plugin` and `core-spring`).

---

## File Structure (the end-state after WA4)

**Moved into `metadata`** (FQNs preserved):
- `server/java/metadata/src/main/java/com/metaobjects/loader/file/{FileMetaDataLoader,FileLoaderOptions,FileMetaDataSources,LocalFileMetaDataSources,URIFileMetaDataSources}.java`
- `server/java/metadata/src/main/java/com/metaobjects/registry/CoreTypeInitializer.java`
- `server/java/metadata/src/main/java/com/metaobjects/io/IOMetaDataProvider.java` (only if it has surviving non-XML uses; otherwise deleted)

**Converted (XML → canonical JSON)**:
- `codegen-base/src/test/resources/schema-validation/invalid-subtypes.json` (new; old `.xml` deleted)
- `codegen-base/src/test/resources/schema-validation/invalid-missing-required.json` (new)
- `codegen-base/src/test/resources/schema-validation/invalid-naming-pattern.json` (new)
- `om/src/test/resources/testdata/produce/v1/Apple.json` (new)

**New (one-shot tool)**:
- `server/java/tools/xml-to-canonical-json/` — a small standalone Maven module OR a shell script under `tools/` that the implementer runs once and then deletes. (Plan picks the lighter option — see Task 8.)

**Deleted**:
- `server/java/core/` entire module
- `<module>core</module>` from `server/java/pom.xml`
- The 7 XML I/O classes (now in old core)
- Any test classes depending on XML I/O (none in `core/src/test` per recon; verify in Task 9)
- The 4 `.xml` metadata fixtures (after conversion to `.json` + test updates)

---

# PHASE 1 — Move file-IO from `core` to `metadata`

End state: 5 file-IO classes physically in `metadata`; consumers (omdb/om/dynamic/etc.) still compile via FQN; reactor green; `core` still exists with 9 files remaining (XML + CoreTypeInitializer + IOMetaDataProvider).

## Task 1: Inventory file-IO transitive deps

**Files:**
- Read-only: the 5 file-IO classes' imports.

- [ ] **Step 1: Enumerate all imports the 5 file-IO classes need:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java
grep -h "^import com.metaobjects" \
  core/src/main/java/com/metaobjects/loader/file/FileMetaDataLoader.java \
  core/src/main/java/com/metaobjects/loader/file/FileLoaderOptions.java \
  core/src/main/java/com/metaobjects/loader/file/FileMetaDataSources.java \
  core/src/main/java/com/metaobjects/loader/file/LocalFileMetaDataSources.java \
  core/src/main/java/com/metaobjects/loader/file/URIFileMetaDataSources.java \
  | sort -u
```

Expected: all imports starting with `com.metaobjects.` should resolve from `metadata`. List any that resolve only from `core` (e.g. `com.metaobjects.io.*` for the XML helpers) — those are PHASE-1 BLOCKERS to flag.

- [ ] **Step 2: Confirm each transitive dep lives in `metadata`:**

For each `com.metaobjects.X.Y` import listed above, run:

```bash
find <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java/metadata/src/main -name 'Y.java' | head -1
```

Each must return a path. If any returns empty → that class is in `core` (not `metadata`) and would block the move. Report the list of blockers. (Expected: 0 blockers. If non-zero, decide per dep: move it too, or refactor the file-IO class to not depend on it.)

- [ ] **Step 3: Commit the inventory** (no code change yet):

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
# Nothing to commit — Task 1 is read-only. Proceed to Task 2.
```

## Task 2: Move the 5 file-IO classes (git mv, package preserved)

**Files:**
- Move: `core/.../loader/file/{FileMetaDataLoader,FileLoaderOptions,FileMetaDataSources,LocalFileMetaDataSources,URIFileMetaDataSources}.java` → `metadata/.../loader/file/`

- [ ] **Step 1: Create the destination directory + move via git:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
mkdir -p server/java/metadata/src/main/java/com/metaobjects/loader/file
for f in FileMetaDataLoader FileLoaderOptions FileMetaDataSources LocalFileMetaDataSources URIFileMetaDataSources; do
  git mv server/java/core/src/main/java/com/metaobjects/loader/file/${f}.java \
         server/java/metadata/src/main/java/com/metaobjects/loader/file/
done
```

Do NOT edit the `package` declarations — they stay `package com.metaobjects.loader.file;` so all consumers' FQN-based imports remain valid.

- [ ] **Step 2: Compile `metadata` standalone** (the strict test — these 5 must compile with only metadata's own deps + the file-IO imports from Task 1):

```bash
cd server/java && mvn -o install -pl metadata -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -10
```

Expected: `BUILD SUCCESS`. If a compile error names a class still in `core`, the Task-1 inventory missed a blocker — go back and resolve it.

- [ ] **Step 3: Compile all dependents** (FQN imports continue to satisfy from the metadata jar):

```bash
cd server/java && mvn -o install -pl core,dynamic,om,omdb,codegen-base,codegen-mustache,codegen-plantuml,maven-plugin,core-spring,omdb-ktx -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -10
```

Expected: `BUILD SUCCESS`. (Consumers import by FQN `com.metaobjects.loader.file.FileMetaDataLoader` etc. — that FQN is now in `metadata`'s jar; the `core` module loses these 5 classes but still has the XML I/O + CoreTypeInitializer + IOMetaDataProvider so it still builds.)

- [ ] **Step 4: Test the modules that use file-IO most heavily:**

```bash
cd server/java && mvn -o -pl metadata test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -3
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java && mvn -o -pl omdb test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -3
```

Expected: metadata 614+/0/0 (more passing now — the file-IO classes can themselves be unit-tested from metadata test scope); omdb 30/0/0.

- [ ] **Step 5: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
refactor(metadata): move file-IO loader from core to metadata (FQNs preserved)

Relocates FileMetaDataLoader, FileLoaderOptions, FileMetaDataSources,
LocalFileMetaDataSources, URIFileMetaDataSources from core into metadata
under the same com.metaobjects.loader.file package, so consumers' imports
continue to resolve unchanged. Matches TS/C#/Python (file-loading lives in
the metadata package). Step 1 of WA4 — does not touch core's XML I/O or
CoreTypeInitializer yet.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

# PHASE 2 — Absorb `CoreTypeInitializer` + decide `IOMetaDataProvider` fate

End state: `CoreTypeInitializer` lives in `metadata`; `IOMetaDataProvider` either moved (if non-XML uses survive) or deleted (if XML-only).

## Task 3: Move `CoreTypeInitializer` into `metadata`

**Files:**
- Move: `core/.../registry/CoreTypeInitializer.java` → `metadata/.../registry/`

- [ ] **Step 1: Inspect `CoreTypeInitializer` to confirm it only depends on `metadata` classes:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
grep -h "^import com.metaobjects" server/java/core/src/main/java/com/metaobjects/registry/CoreTypeInitializer.java | sort -u
```

For each import, verify the target lives in `metadata` (Task 1 method). If something is core-only, it's a blocker — report and decide.

- [ ] **Step 2: Find all references to `CoreTypeInitializer` across the reactor:**

```bash
grep -rn "CoreTypeInitializer\|core.registry.CoreTypeInitializer" server/java --include=*.java --include=*.xml --include=*.properties -- . 2>/dev/null | grep -v /target/
grep -rn "CoreTypeInitializer" server/java/*/src/main/resources/META-INF 2>/dev/null
```

Note where it's referenced — typical: a META-INF/services SPI registration, or direct calls in providers/tests. Each reference must continue to resolve after the move (FQN preserved).

- [ ] **Step 3: Move it:**

```bash
git mv server/java/core/src/main/java/com/metaobjects/registry/CoreTypeInitializer.java \
       server/java/metadata/src/main/java/com/metaobjects/registry/
```

Do not edit the `package` declaration.

- [ ] **Step 4: Compile + test the reactor (modules that depend on core most directly):**

```bash
cd server/java && mvn -o install -pl metadata,core,dynamic,om,omdb,codegen-base,codegen-mustache,codegen-plantuml,maven-plugin,core-spring,omdb-ktx -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -5
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java && mvn -o -pl metadata test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -3
```

Expected: BUILD SUCCESS + metadata 614+/0/0.

- [ ] **Step 5: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
refactor(metadata): absorb CoreTypeInitializer into metadata (FQN preserved)

Moves CoreTypeInitializer from core.registry to metadata.registry under the
same package; SPI / direct-call references continue to resolve. Step 2 of WA4.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Task 4: Decide `IOMetaDataProvider` fate (move or delete)

**Files:**
- Read-only first, then: Move OR Delete `core/.../io/IOMetaDataProvider.java`.

- [ ] **Step 1: Inspect the class + find its references:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
cat server/java/core/src/main/java/com/metaobjects/io/IOMetaDataProvider.java
grep -rn "IOMetaDataProvider" server/java --include=*.java --include=*.xml --include=*.properties 2>/dev/null | grep -v /target/
grep -rn "IOMetaDataProvider" server/java/*/src/main/resources/META-INF 2>/dev/null
```

- [ ] **Step 2: Decide based on content:**

  - **If it only registers XML I/O types** and has no other surviving use → DELETE it now (will go away with the XML I/O drop in Phase 3 anyway; deleting now avoids a dangling reference). Also drop any SPI entry.
  - **If it registers non-XML I/O types too** (e.g. JSON I/O providers) → MOVE it to `metadata/.../io/IOMetaDataProvider.java` (FQN preserved) and trim out the XML-specific registrations only.
  - **If it is genuinely empty (per spec)** → DELETE it.

Report which choice you made and why.

- [ ] **Step 3: Apply the move OR deletion:**

If MOVE:
```bash
mkdir -p server/java/metadata/src/main/java/com/metaobjects/io
git mv server/java/core/src/main/java/com/metaobjects/io/IOMetaDataProvider.java \
       server/java/metadata/src/main/java/com/metaobjects/io/
```

If DELETE:
```bash
git rm server/java/core/src/main/java/com/metaobjects/io/IOMetaDataProvider.java
# also remove the SPI entry if present:
grep -rl "com.metaobjects.io.IOMetaDataProvider" server/java/*/src/main/resources/META-INF
# Edit each listed META-INF/services file to remove the line, then:
git add -A
```

- [ ] **Step 4: Compile + test:**

```bash
cd server/java && mvn -o install -pl metadata,core,dynamic,om,omdb,codegen-base,codegen-mustache,codegen-plantuml,maven-plugin,core-spring,omdb-ktx -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -5
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java && mvn -o -pl metadata,omdb test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -4
```

Expected: BUILD SUCCESS + tests unchanged.

- [ ] **Step 5: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
refactor(metadata): <move|drop> IOMetaDataProvider (<one-line rationale>)

Step 3 of WA4: handle the IOMetaDataProvider SPI ahead of the XML I/O drop.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```
(Replace `<move|drop>` and the rationale with what actually happened in Step 2.)

---

# PHASE 3 — Convert XML fixtures to canonical JSON + delete XML I/O

End state: 4 metadata XML fixtures replaced by canonical JSON, tests updated to load JSON; 7 XML I/O classes deleted; any XML-loader tests deleted.

## Task 5: Inspect the 4 XML fixtures + identify the tests that load them

**Files:**
- Read-only.

- [ ] **Step 1: Print each fixture and find its consuming test(s):**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
for f in \
  server/java/codegen-base/src/test/resources/schema-validation/invalid-subtypes.xml \
  server/java/codegen-base/src/test/resources/schema-validation/invalid-missing-required.xml \
  server/java/codegen-base/src/test/resources/schema-validation/invalid-naming-pattern.xml \
  server/java/om/src/test/resources/testdata/produce/v1/Apple.xml ; do
  echo "===== $f ====="
  cat "$f"
  echo "----- loaded by -----"
  base=$(basename "$f")
  grep -rln "$base" server/java --include=*.java 2>/dev/null | grep -v /target/
done
```

Capture: (a) each fixture's structural content (entity/field/identity/source shape); (b) which test classes load each one.

- [ ] **Step 2: Confirm there are NO other XML metadata fixtures the recon missed:**

```bash
find server/java -name '*.xml' -not -path '*/target/*' -path '*/test/*' \
  | xargs grep -l '<object\|<field\|<identity\|<source\|<metadata' 2>/dev/null \
  | grep -v /target/
```

Should print only the 4 fixtures above (and possibly nothing else if those exact tags don't appear in the XML — check each output line, ignore `logback-test.xml` / `pom.xml`). Report any extras.

- [ ] **Step 3: No commit yet — proceed to Task 6.**

## Task 6: Hand-convert the 4 fixtures to canonical JSON

**Files:**
- Create: 4 `.json` files (paired with each `.xml`).

**Why hand-convert and not a tool:** 4 small fixtures; writing a robust XML→canonical-JSON tool is more code than the conversion. (If conversion turns out tedious or the count grows, fall back to a small Bash/Python script — Task 7 has the option.) Each conversion is mechanical: the Java XML loader's element/attribute mapping → canonical fused-key JSON shape (`{ "<type>.<subType>": { "name": ..., "@attr": ..., "children": [...] } }`).

- [ ] **Step 1: Convert `invalid-subtypes.xml` → `invalid-subtypes.json`:**

Read the XML (printed in Task 5). Write the canonical JSON equivalent at `server/java/codegen-base/src/test/resources/schema-validation/invalid-subtypes.json`. The XML→JSON mapping rule: every element `<type subType="X" name="Y">` becomes `{ "type.X": { "name": "Y", ... } }`; attributes become `@`-prefixed; nested elements go into `children: [...]`. Reserved structural keys (`name`/`package`/`extends`/`abstract`/`overlay`/`isArray`/`children`/`value`) stay bare. Match the conventions used by the existing JSON fixtures in the same directory (`grep -l '"metadata.root"' server/java/codegen-base/src/test/resources/schema-validation/*.json` — read one as a reference).

- [ ] **Step 2: Convert `invalid-missing-required.xml` + `invalid-naming-pattern.xml` + `Apple.xml`:**

Repeat Step 1 for the other 3 fixtures. Each conversion must produce a file that, when loaded by `CanonicalJsonParser`, produces the same MetaRoot tree the XML loader produced (the consuming test's assertions should still pass against the JSON version).

- [ ] **Step 3: Update the consuming test(s) to load the JSON instead of the XML:**

For each consuming test class identified in Task 5, change the resource path from `<name>.xml` to `<name>.json` (and any loader-construction code from `FileMetaDataLoader` configured for XML to the default canonical-JSON path — usually a 1–2 line change since `FileMetaDataLoader` auto-detects by extension OR the test specifies the parser).

- [ ] **Step 4: Run the affected modules' tests:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java
mvn -o -pl codegen-base test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -3
mvn -o -pl om test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -3
```

Expected: codegen-base 23/0/0 + om 5/0/0 (or whatever the baselines are) — same numbers as before, just running against JSON now. Iterate on any failures by inspecting the converted JSON vs. expected behavior.

- [ ] **Step 5: Delete the 4 `.xml` fixtures (only after the JSON-based tests are green):**

```bash
git rm server/java/codegen-base/src/test/resources/schema-validation/invalid-subtypes.xml
git rm server/java/codegen-base/src/test/resources/schema-validation/invalid-missing-required.xml
git rm server/java/codegen-base/src/test/resources/schema-validation/invalid-naming-pattern.xml
git rm server/java/om/src/test/resources/testdata/produce/v1/Apple.xml
```

- [ ] **Step 6: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
test(java): convert remaining 4 metadata XML fixtures to canonical JSON

Hand-converted invalid-subtypes/invalid-missing-required/invalid-naming-pattern
(codegen-base/schema-validation) + Apple (om/testdata) from XML to canonical
JSON; updated the consuming tests to load the .json variants. XML I/O classes
deleted in the next step (WA4 step 4 of the loader-consolidation plan).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Task 7: (Optional) Write a small XML→canonical-JSON converter script

**Files:**
- Create (only if Task 6 hits ≥3 ambiguous mappings): `tools/xml-to-canonical-json.py` OR `.sh`. Skip if Task 6 was straightforward — this is purely a productivity escape valve.

- [ ] **Step 1:** If Task 6 was uneventful, **SKIP this task entirely** — note that in the report and move on.

- [ ] **Step 2:** If Task 6 hit repeated mappings worth automating, write a small Python script using `xml.etree.ElementTree` that mirrors the same rules used by hand in Task 6 (element → fused-key wrapper, attributes → `@`-prefixed except reserved, nested → `children` array). Place under `tools/xml-to-canonical-json.py`. The script is a one-shot — it can be deleted after WA4 lands (the user owns that decision).

- [ ] **Step 3:** Commit (only if a script was written): `chore(tools): one-shot XML→canonical-JSON converter for legacy metadata fixtures (WA4)`.

## Task 8: Delete the 7 XML I/O classes + any depending tests

**Files:**
- Delete: 7 XML classes in `core/src/main/.../io/{xml,object/xml}/`.
- Delete: any test classes in `core/src/test` (or elsewhere) that test the XML I/O.

- [ ] **Step 1: Final scan for production callers** (must be zero before deletion):

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
grep -rn "XMLMetaDataReader\|XMLMetaDataWriter\|XMLObjectReader\|XMLObjectWriter\|XMLIOUtil\|XMLIOConstants\|XMLSerializationHandler" \
  server/java --include=*.java 2>/dev/null \
  | grep -v /target/
```

Note every match. Any in `*/src/main/` is a production caller — must re-point or delete that caller's XML-using code first. Any in `*/src/test/` will be test classes that need to go (Step 3). Any in the 7 XML classes themselves (self-references) are fine — they're getting deleted.

- [ ] **Step 2: Re-point or delete production callers** (only if Step 1 found any in `src/main`):

For each `src/main` reference, decide:
- If it imports the XML class but the using method/branch is dead → delete the unused import + branch.
- If it actively uses XML I/O → that's a feature being removed; delete the using class/method (the spec says XML I/O is out, canonical JSON is the only format).

Report each decision.

- [ ] **Step 3: Locate + delete XML test classes:**

```bash
grep -rl "XMLMetaDataReader\|XMLMetaDataWriter\|XMLObjectReader\|XMLObjectWriter\|XMLIOUtil\|XMLSerializationHandler" \
  server/java --include=*.java 2>/dev/null \
  | grep /test/ \
  | grep -v /target/
```

For each test class listed, `git rm` it (the test exercises a deleted feature):

```bash
# Example — actual list comes from the grep above
git rm <each-listed-test-file>
```

- [ ] **Step 4: Delete the 7 XML I/O classes:**

```bash
git rm server/java/core/src/main/java/com/metaobjects/io/xml/XMLMetaDataReader.java
git rm server/java/core/src/main/java/com/metaobjects/io/xml/XMLMetaDataWriter.java
git rm server/java/core/src/main/java/com/metaobjects/io/xml/XMLIOUtil.java
git rm server/java/core/src/main/java/com/metaobjects/io/xml/XMLIOConstants.java
git rm server/java/core/src/main/java/com/metaobjects/io/xml/XMLSerializationHandler.java
git rm server/java/core/src/main/java/com/metaobjects/io/object/xml/XMLObjectReader.java
git rm server/java/core/src/main/java/com/metaobjects/io/object/xml/XMLObjectWriter.java
```

- [ ] **Step 5: Reactor green:**

```bash
cd server/java && mvn -o install -pl metadata,core,dynamic,om,omdb,codegen-base,codegen-mustache,codegen-plantuml,maven-plugin,core-spring,omdb-ktx -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -5
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java
for m in metadata core dynamic om omdb codegen-base codegen-mustache codegen-plantuml maven-plugin core-spring; do
  echo "== $m =="
  mvn -o -pl $m test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD (SUCCESS|FAILURE)" | grep -vE "Time elapsed" | tail -2
done
```

Expected: all green (test counts may shift down for any module whose XML tests were deleted in Step 3 — that's correct).

- [ ] **Step 6: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
refactor(java): drop legacy XML I/O (XMLMetaData/Object Reader/Writer, helpers)

Canonical JSON is the only supported on-disk format. Deletes 7 XML I/O classes
from core (XMLMetaDataReader/Writer, XMLObjectReader/Writer, XMLIOUtil,
XMLIOConstants, XMLSerializationHandler) and their dedicated test classes.
Production callers and metadata XML fixtures were re-pointed to canonical JSON
in earlier WA4 steps. core now holds only file-IO loader (already moved) +
CoreTypeInitializer (already moved) — emptying core ahead of the collapse.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

# PHASE 4 — Re-point dependents + delete the `core` module

End state: `core` module deleted; reactor builds without it; all dependents resolve their (previously core-resident) imports from `metadata`.

## Task 9: Re-point the 6 dependent module poms

**Files:**
- Modify: `omdb/pom.xml`, `dynamic/pom.xml`, `omdb-ktx/pom.xml`, `maven-plugin/pom.xml`, `core-spring/pom.xml`, `om/pom.xml`.

- [ ] **Step 1: For each pom, replace the core dependency with metadata.** The exact XML block to find + replace:

```xml
<!-- Find: -->
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-core</artifactId>
    <version>${project.version}</version>
</dependency>
```

Replace with:

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata</artifactId>
    <version>${project.version}</version>
</dependency>
```

**Caveat — already-depends-on-metadata:** several of these poms likely already declare an explicit `metaobjects-metadata` dependency (since they import metadata classes too). If so, the re-point becomes a DELETE of the `metaobjects-core` dependency block — re-adding metadata would duplicate it. Inspect each pom first; choose REPLACE vs DELETE accordingly.

- [ ] **Step 2: Apply to all 6 poms:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
for p in omdb dynamic omdb-ktx maven-plugin core-spring om; do
  echo "===== $p/pom.xml current core dep ====="
  grep -A3 -B1 "metaobjects-core" server/java/$p/pom.xml | head -10
done
```

For each, edit the pom by hand per the rule above. Confirm afterwards:

```bash
grep -l "metaobjects-core" server/java/*/pom.xml | grep -v core/pom.xml
# Expected: empty (no remaining metaobjects-core dependencies)
```

- [ ] **Step 3: Reactor build (note: `core` module still in the reactor at this step):**

```bash
cd server/java && mvn -o install -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -5
```

Expected: BUILD SUCCESS (consumers no longer depend on core; core builds standalone, still — it just has nothing left except what was moved in P1/P2 and whatever wasn't deleted in P3).

- [ ] **Step 4: Test all dependents to confirm they still work without the core dep:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java
for m in omdb dynamic omdb-ktx maven-plugin core-spring om; do
  echo "== $m =="
  mvn -o -pl $m test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD (SUCCESS|FAILURE)" | grep -vE "Time elapsed" | tail -2
done
```

Expected: all green.

- [ ] **Step 5: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
refactor(java): re-point omdb/om/dynamic/omdb-ktx/maven-plugin/core-spring poms from metaobjects-core to metaobjects-metadata

All file-IO + CoreTypeInitializer + (surviving) IOMetaDataProvider classes now
live in metadata; the metaobjects-core artifact has no surviving callers.
Module deletion follows in the next step.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Task 10: Delete the `core` module

**Files:**
- Delete: entire `server/java/core/` directory.
- Modify: `server/java/pom.xml` — remove `<module>core</module>` from `<modules>`.

- [ ] **Step 1: Confirm `core` is genuinely empty of non-trivial Java** (only what's been touched in P1-P3 should remain):

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
find server/java/core -name '*.java' -not -path '*/target/*'
```

Expected: empty (every `.java` was either moved or deleted in P1–P3). If anything remains, decide per file: move-too or delete (re-run the inventory + decision pattern from earlier tasks).

- [ ] **Step 2: Remove the module entry from the parent pom:**

```bash
# Edit server/java/pom.xml — delete the line `<module>core</module>` (line 41 per recon).
```

Use the Edit tool, removing only that one line (the surrounding `<module>maven-plugin</module>` and `<module>core-spring</module>` stay).

- [ ] **Step 3: Delete the `core` directory:**

```bash
git rm -rf server/java/core/
```

- [ ] **Step 4: Reactor green:**

```bash
cd server/java && mvn -o install -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -5
mvn -o test 2>&1 | grep -E "^\[INFO\] (Building|Reactor Summary)|Tests run: [0-9]+, Fail|BUILD (SUCCESS|FAILURE)" | grep -vE "Time elapsed" | tail -30
```

Expected: BUILD SUCCESS; reactor lists modules WITHOUT `core`; all test counts match the prior-phase baselines (sans the deleted XML tests). Any failure is fallout to fix.

- [ ] **Step 5: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
refactor(java): delete the core module — collapse into metadata

End-state for WA4: server/java now has one type-system + loader module
(metadata) instead of the metadata+core split that diverged from TS/C#/Python.
Module count 13 → 12. Removed <module>core</module> from server/java/pom.xml.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

# PHASE 5 — WA5: Conformance gate

End state: explicit assertion that the aligned vocabulary (`entity`/`value` + `source.rdb` + `@kind`/`@role` + `origin.*` + camelCase preservation) parses + canonical-round-trips on the shared corpus; ledger reflects the truth post-WA4.

## Task 11: Audit + assertion of the aligned vocabulary

**Files:**
- Read-only audit; possible new test at `metadata/src/test/java/com/metaobjects/conformance/AlignedVocabularyTest.java`.

- [ ] **Step 1: Re-run `ConformanceTest` after WA4 + capture the ledger state:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java
mvn -o -pl metadata test -Dtest=ConformanceTest 2>&1 | grep -E "Tests run:|<<< FAILURE|BUILD" | tail -5
wc -l ../metadata/conformance-expected-failures.json
```

Expected: ConformanceTest 168/0/0; ledger 30 entries (unchanged from pre-WA4 — WA4 doesn't add or close conformance entries).

- [ ] **Step 2: Verify the aligned vocabulary fixtures all pass** (the WA1–WA4 success criterion per spec §87):

For each fixture name in the list, run the parameterized case via `-Dtest=ConformanceTest#conformance[<name>]` and confirm PASS:
- `source-rdb-column`, `source-rdb-referential-actions`, `source-multi-source-roles`, `error-source-multiple-primary`, `subtype-entity-missing-primary-warning` (source-v2)
- `origin-passthrough-simple`, `origin-aggregate-count`, `origin-aggregate-sum`, `origin-collection-simple`, `origin-multi-level-via`, `source-db-view-projection`, `error-origin-bad-aggregate-fn`, `error-origin-bad-via-path` (origin)
- `camelCaseSubtypeRoundTrip` if present (casing) — also run `CamelCaseSubtypeRoundTripTest` directly:

```bash
mvn -o -pl metadata test -Dtest=ConformanceTest 2>&1 \
  | grep -E "source-rdb|origin-|source-multi-source|error-source-multiple|subtype-entity-missing|source-db-view-projection|camelCase" \
  | head -20
mvn -o -pl metadata test -Dtest=CamelCaseSubtypeRoundTripTest 2>&1 | grep -E "Tests run:|BUILD" | tail
```

Expected: all listed cases PASS; CamelCaseSubtypeRoundTripTest green. If any vocab fixture is failing or unexpectedly ledgered, that's a WA5 failure — investigate + fix or re-ledger with a clear comment.

- [ ] **Step 3: Add an explicit aligned-vocabulary smoke test** at `metadata/src/test/java/com/metaobjects/conformance/AlignedVocabularyTest.java` — a small JUnit4 test that:
  - Loads inline canonical-JSON exercising `object.entity` + `object.value` + `source.rdb {@kind:"view", @role:"replica", @table:"v_x"}` + `origin.passthrough {@from:"X.y"}` in one tree.
  - Asserts each node loads with the correct subType (case-sensitive) + the attrs are present.
  - Round-trips via `CanonicalJsonSerializer.canonicalSerialize(...)` + asserts the output contains all the same `object.entity`/`object.value`/`source.rdb`/`origin.passthrough` keys with their exact casing.

Full code for the test:

```java
package com.metaobjects.conformance;

import com.metaobjects.MetaData;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

import static org.junit.Assert.*;

/**
 * WA5 gate: the aligned cross-language vocabulary (object.entity/value +
 * source.rdb + @kind/@role + origin.* + camelCase) loads and canonical-
 * round-trips byte-faithfully in Java.
 */
public class AlignedVocabularyTest extends SharedRegistryTestBase {

    private static final String FIXTURE = "{ \"metadata.root\": { \"package\": \"acme::commerce\", \"children\": [" +
        "  { \"object.entity\": { \"name\": \"Program\", \"children\": [" +
        "    { \"source.rdb\":   { \"@table\": \"programs\" } }," +
        "    { \"field.long\":   { \"name\": \"id\" } }," +
        "    { \"field.string\": { \"name\": \"title\" } }," +
        "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
        "  ] } }," +
        "  { \"object.entity\": { \"name\": \"ProgramSummary\", \"extends\": \"Program\", \"children\": [" +
        "    { \"source.rdb\": { \"@kind\": \"view\", \"@role\": \"replica\", \"@table\": \"v_program\" } }," +
        "    { \"field.string\": { \"name\": \"displayTitle\", \"children\": [" +
        "      { \"origin.passthrough\": { \"@from\": \"Program.title\" } }" +
        "    ] } }," +
        "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
        "  ] } }," +
        "  { \"object.value\": { \"name\": \"Money\", \"children\": [" +
        "    { \"field.long\": { \"name\": \"cents\" } }" +
        "  ] } }" +
        "] } }";

    @Test public void alignedVocabularyLoadsAndRoundTrips() {
        MetaDataLoader loader = createTestLoader("AlignedVocabularyTest", Collections.emptyList());
        CanonicalJsonParser parser = new CanonicalJsonParser(loader, "aligned.json");
        parser.loadFromStream(new ByteArrayInputStream(FIXTURE.getBytes(StandardCharsets.UTF_8)));

        // Subtypes are case-preserved and present
        MetaData program = loader.getRoot().getChildOfType("object", "acme::commerce::Program");
        assertEquals("entity", program.getSubType());
        MetaData summary = loader.getRoot().getChildOfType("object", "acme::commerce::ProgramSummary");
        assertEquals("entity", summary.getSubType());
        MetaData money   = loader.getRoot().getChildOfType("object", "acme::commerce::Money");
        assertEquals("value", money.getSubType());

        // Canonical round-trip preserves the exact casing + attrs
        String json = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("expected object.entity", json.contains("\"object.entity\""));
        assertTrue("expected object.value",  json.contains("\"object.value\""));
        assertTrue("expected source.rdb",    json.contains("\"source.rdb\""));
        assertTrue("expected origin.passthrough", json.contains("\"origin.passthrough\""));
        assertTrue("expected @kind: view",   json.contains("\"@kind\": \"view\""));
        assertTrue("expected @role: replica",json.contains("\"@role\": \"replica\""));
        assertTrue("expected @table",        json.contains("\"@table\""));
        assertTrue("expected @from",         json.contains("\"@from\""));

        // Must NOT contain any retired vocabulary
        assertFalse("must not leak source.dbTable", json.contains("\"source.dbTable\""));
        assertFalse("must not leak source.dbView",  json.contains("\"source.dbView\""));
        assertFalse("must not leak object.pojo",    json.contains("\"object.pojo\""));
        assertFalse("must not leak object.map",     json.contains("\"object.map\""));
        assertFalse("must not leak object.proxy",   json.contains("\"object.proxy\""));
        assertFalse("must not leak @javaRuntime",   json.contains("javaRuntime"));
    }
}
```

- [ ] **Step 4: Run the new test + the full metadata suite:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java
mvn -o -pl metadata test -Dtest=AlignedVocabularyTest 2>&1 | grep -E "Tests run:|BUILD" | tail -3
mvn -o -pl metadata test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -3
```

Expected: AlignedVocabularyTest `Tests run: 1, Failures: 0`; metadata 615+/0/0.

- [ ] **Step 5: Commit:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
git add -A
git commit -m "$(cat <<'EOF'
test(metadata): WA5 conformance gate — aligned-vocabulary smoke test

Single load+round-trip test exercising object.entity/object.value +
source.rdb + @kind/@role + origin.passthrough + camelCase subtype casing,
asserting the new vocabulary lands AND none of the retired vocabulary
(source.dbTable/dbView, object.pojo/map/proxy, @javaRuntime) leaks back
into canonical output. WA5 complete.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Task 12: Final reactor green + ledger audit

- [ ] **Step 1: Full reactor:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation/server/java
mvn -o install -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail -3
mvn -o test 2>&1 | grep -E "^\[INFO\] Building|Tests run: [0-9]+, Fail|BUILD (SUCCESS|FAILURE)" | grep -vE "Time elapsed" | tail -30
```

Expected: every module BUILD SUCCESS, all test counts ≥ pre-WA4 baselines (sans deleted XML tests), no module reports failures. Specifically: `core` no longer appears in the reactor build list.

- [ ] **Step 2: Audit the ledger one more time:**

```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
cat server/java/metadata/conformance-expected-failures.json
```

Confirm: no entry mentions `source-rdb-*` / `origin-*` / `subtype-entity-missing-primary-warning` / `source-db-view-projection` / `error-origin-*` (all closed earlier this branch's lineage). Any remaining entries are honest known-gaps unrelated to WA1–WA4 (currency, layout, template, attr-filter, etc.).

- [ ] **Step 3: WA5 sign-off note in the commit if anything changed; otherwise no commit needed.** (Step 1 + Step 2 are read-only verification.)

---

## Self-Review

- **Spec coverage:**
  - WA4 §75 (move file-IO into metadata) → Task 2.
  - WA4 §75 (FileMetaDataLoader / FileMetaDataSources / LocalFileMetaDataSources / URIFileMetaDataSources / FileLoaderOptions) → all listed in Task 2.
  - WA4 §79 (after move, core has only XML I/O + CoreTypeInitializer + IOMetaDataProvider) → matches recon (14 files − 5 moved = 9 remaining = 7 XML + CoreTypeInitializer + IOMetaDataProvider).
  - WA4 §79 (drop legacy XML I/O) → Task 8.
  - WA4 §79 (collapse core into metadata, absorbing CoreTypeInitializer) → Task 3 (CoreTypeInitializer) + Task 10 (core deletion).
  - WA4 §79 (re-point dependents) → Task 9.
  - WA4 §83 (one metadata module owning the type system + loader) → end-state after Task 10.
  - WA5 §87 (prove aligned vocabulary loads + round-trips) → Task 11 (AlignedVocabularyTest).
  - WA5 §87 (move now-passing fixtures off the gap list) → already done in this session's lineage; Task 12 audits + confirms.
  - User decision on XML fixture conversion: "one-shot XML→canonical-JSON converter for the ~5-6 real metadata XML fixtures" → Tasks 6/7 (4 files; Task 7 makes the script optional given the small count).
- **Placeholder scan:** All commands and code blocks are exact. The two "report which choice you made" steps (Task 4 IOMetaDataProvider, Task 9 REPLACE-vs-DELETE) are legitimate per-file decisions made empirically from `grep`/`cat` output — they're decision-tree branches, not placeholders.
- **Type consistency:** File paths are absolute or worktree-rooted throughout. Class names match the recon (`FileMetaDataLoader`, `CoreTypeInitializer`, etc.). pom-edit XML uses the project's actual conventions (`<groupId>com.metaobjects</groupId>` per the existing dependency blocks — verify in Task 9 Step 2 against the real poms).
- **Risk flags for the implementer:**
  - Task 2 Step 2: a transitive dep blocker (Task 1 missed a class) — easy to spot, hard to predict.
  - Task 6 Step 3: tests may construct `FileMetaDataLoader` with an explicit XML parser; if so, more work than just renaming the resource.
  - Task 8 Step 2: production callers of XML I/O — should be zero, but verify before deleting.
  - Task 9 Step 1 caveat: REPLACE vs DELETE per pom; explicit instruction included.
