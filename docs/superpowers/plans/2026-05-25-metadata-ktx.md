# metadata-ktx Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `metaobjects-metadata-ktx` — a thin idiomatic-Kotlin facade over the Java MetaObjects engine, including loader factory shortcuts, READ navigation (typed nullable enums, reified field access, attr helpers, platform-nullability pinning), and FR-004 template/render integration.

**Architecture:** Single new Maven module mirroring `metaobjects-omdb-ktx` shape. Top-level extension functions only (no wrapper class) per the locked design. 7 source files + 6 test files. Wrap-where-friction principle: wrap only where Kotlin interop has real friction (Optional→T?, platform-nullability, typed enums, reified generics, top-level loader fns matching cross-port convention, render { } builder for FR-004 RenderRequest).

**Tech Stack:** Kotlin 2.0.21, Java 21, Maven, JUnit5 + kotlin-test-junit5, deps `metaobjects-metadata` + `metaobjects-render`.

**Spec:** [docs/superpowers/specs/2026-05-25-metadata-ktx-kotlin-facade-design.md](../specs/2026-05-25-metadata-ktx-kotlin-facade-design.md)

**Reference (mirror its shape exactly):** `server/java/omdb-ktx/` (pom + src layout + plugin config + test wiring).

---

## Branch + Gate

- **Branch:** `worktree-metadata-ktx` (already checked out off main).
- **Per-Phase gate:** After all impl tasks complete, run **code-reviewer + code-simplifier** subagents in parallel, fix Importants, then merge to main.

---

### Task 1: Module scaffolding — pom + directory tree

**Files:**
- Create: `server/java/metadata-ktx/pom.xml`
- Create: `server/java/metadata-ktx/README.md`
- Create: directory tree `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/`
- Create: directory tree `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/`
- Modify: `server/java/pom.xml` — APPEND `<module>metadata-ktx</module>` to `<modules>` (after `metadata`, before `omdb-ktx`)

- [ ] **Step 1: Read the reference pom**

```bash
cat /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java/omdb-ktx/pom.xml
```

The metadata-ktx pom is a near-direct copy with these changes:
- `<artifactId>metaobjects-metadata-ktx</artifactId>`
- `<name>MetaObjects :: Metadata Kotlin Facade</name>`
- `<description>Idiomatic Kotlin facade over the Java metadata loader + FR-004 template + render engine.</description>`
- **Dependencies changed**: drop `metaobjects-omdb`, `metaobjects-core-spring`, `derby*`. Add `metaobjects-metadata` + `metaobjects-render` + (test-scope) `metaobjects-metadata` test-jar for `SharedRegistryTestBase`.
- **Build plugins identical** (kotlin-maven-plugin, sourceDirectory/testSourceDirectory).

- [ ] **Step 2: Write the pom**

`server/java/metadata-ktx/pom.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects</artifactId>
    <version>7.0.0-SNAPSHOT</version>
  </parent>

  <artifactId>metaobjects-metadata-ktx</artifactId>
  <name>MetaObjects :: Metadata Kotlin Facade</name>
  <description>Idiomatic Kotlin facade over the Java metadata loader + FR-004 template + render engine.</description>

  <properties>
    <kotlin.version>2.0.21</kotlin.version>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-stdlib</artifactId>
      <version>${kotlin.version}</version>
    </dependency>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-metadata</artifactId>
      <version>${project.version}</version>
    </dependency>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-render</artifactId>
      <version>${project.version}</version>
    </dependency>

    <!-- test -->
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-test-junit5</artifactId>
      <version>${kotlin.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-metadata</artifactId>
      <version>${project.version}</version>
      <type>test-jar</type>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <sourceDirectory>src/main/kotlin</sourceDirectory>
    <testSourceDirectory>src/test/kotlin</testSourceDirectory>
    <plugins>
      <!-- COPY plugin block VERBATIM from server/java/omdb-ktx/pom.xml -->
    </plugins>
  </build>
</project>
```

Inspect `server/java/omdb-ktx/pom.xml` for the exact `<build><plugins>` block (kotlin-maven-plugin with `compile`/`test-compile` executions + `maven-surefire-plugin` config) and copy verbatim.

- [ ] **Step 3: Register the module + create directories**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
mkdir -p server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx
mkdir -p server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx
```

Edit `server/java/pom.xml` `<modules>`. Add a line `<module>metadata-ktx</module>` after `<module>metadata</module>` and before `<module>omdb-ktx</module>`.

- [ ] **Step 4: Write a placeholder README**

`server/java/metadata-ktx/README.md` (short — populated in Task 9):

```markdown
# MetaObjects :: Metadata Kotlin Facade (`metadata-ktx`)

A thin Kotlin extension layer over the Java MetaObjects engine.
No forking, no reimplementation — just idiomatic Kotlin syntax on top of the existing Java API.

(README populated by implementation plan task 9.)
```

- [ ] **Step 5: Verify the module compiles empty**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java
mvn -pl metadata-ktx validate -q 2>&1 | tail -3
```

Expected: success.

- [ ] **Step 6: Commit**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git add server/java/metadata-ktx/pom.xml server/java/metadata-ktx/README.md server/java/pom.xml
git commit -m "build(java): scaffold metaobjects-metadata-ktx module"
```

---

### Task 2: `Loader.kt` — top-level loader factory shortcuts

**Files:**
- Create: `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/Loader.kt`
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/LoaderTest.kt`

- [ ] **Step 1: Verify Java MetaDataLoader factory signatures**

Read `server/java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java` and find the `fromDirectory` / `fromUris` / `fromResources` / `fromString` static methods. Confirm the parameter shapes (the spec assumes `name: String` first arg; verify).

- [ ] **Step 2: Write the failing test**

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.loader.MetaDataSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class LoaderTest {

    private val tinyJson = """{ "metadata.root": { "package": "acme", "children": [] } }"""

    @Test fun `loadString returns a populated MetaDataLoader`() {
        val loader = loadString("test", tinyJson)
        assertNotNull(loader.root)
        assertEquals("test", loader.name)
    }

    @Test fun `loadString accepts YAML format`() {
        val yaml = "metadata.root:\n  package: acme\n  children: []\n"
        val loader = loadString("y", yaml, MetaDataSource.MetaDataFormat.YAML)
        assertNotNull(loader.root)
    }
}
```

- [ ] **Step 3: Verify failure**

```bash
mvn -pl metadata-ktx test -q -Dtest=LoaderTest 2>&1 | tail -10
```

Expected: FAIL — Loader.kt doesn't exist.

- [ ] **Step 4: Write the impl**

`Loader.kt`:

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource.MetaDataFormat
import java.net.URI
import java.nio.file.Path

fun loadDirectory(name: String, directory: Path): MetaDataLoader =
    MetaDataLoader.fromDirectory(name, directory)

fun loadDirectory(name: String, directory: Path, opts: LoaderOptions): MetaDataLoader =
    MetaDataLoader.fromDirectory(name, directory, opts)

fun loadUris(name: String, uris: List<URI>): MetaDataLoader =
    MetaDataLoader.fromUris(name, uris)

fun loadUris(name: String, uris: List<URI>, opts: LoaderOptions): MetaDataLoader =
    MetaDataLoader.fromUris(name, uris, opts)

fun loadResources(name: String, resources: List<String>): MetaDataLoader =
    MetaDataLoader.fromResources(name, resources)

fun loadResources(name: String, resources: List<String>, opts: LoaderOptions): MetaDataLoader =
    MetaDataLoader.fromResources(name, resources, opts)

fun loadString(name: String, content: String, format: MetaDataFormat = MetaDataFormat.JSON): MetaDataLoader =
    MetaDataLoader.fromString(name, content, format)
```

**If the actual Java factory signatures differ** (e.g., `fromDirectory(String name, java.nio.file.Path)` but no LoaderOptions overload), adjust to match. Compile is the gate.

- [ ] **Step 5: Tests pass**

```bash
mvn -pl metadata-ktx test -q -Dtest=LoaderTest 2>&1 | tail -5
```

Expected: 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git add server/java/metadata-ktx
git commit -m "feat(metadata-ktx): Loader — top-level loadDirectory/loadUris/loadResources/loadString fns"
```

---

### Task 3: `MetaObjects.kt` — null-returning lookups + template subtype access

**Files:**
- Create: `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/MetaObjects.kt`
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/MetaObjectsTest.kt`

- [ ] **Step 1: Verify Java APIs**

In `MetaDataLoader.java` and `MetaDataLoaderRegistry.java`, find:
- The method that looks up a `MetaObject` by name (likely `getMetaObjectByName(String)` returning `MetaObject` and throwing `MetaDataNotFoundException`, or `findMetaObject(String)` returning `Optional<MetaObject>`)
- The method that gets children by type from MetaRoot (likely `getChildOfType(String, String)` returning `MetaData` or `findChildByType(...)` returning `Optional<MetaData>`)
- The exact `MetaDataNotFoundException` package + name

Match the catch and lookup to whatever's actually there.

- [ ] **Step 2: Write the failing test**

```kotlin
package com.metaobjects.metadata.ktx

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class MetaObjectsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": { "name": "Payload", "children": [
              { "field.string": { "name": "q" } }
          ] } },
          { "template.prompt": { "name": "MyPrompt",
              "@payloadRef": "Payload",
              "@textRef": "ai/p" } },
          { "template.output": { "name": "MyOutput",
              "@payloadRef": "Payload",
              "@textRef": "ai/o" } }
        ]
      }
    }"""

    private fun loader() = loadString("t", fixture)

    @Test fun `metaObjectOrNull returns object when present`() {
        val obj = loader().metaObjectOrNull("acme::ai::Payload")
        assertNotNull(obj)
        assertEquals("value", obj.subType)
    }

    @Test fun `metaObjectOrNull returns null when absent`() {
        assertNull(loader().metaObjectOrNull("acme::ai::NoSuch"))
    }

    @Test fun `templateOrNull returns base type when present`() {
        val t = loader().templateOrNull("acme::ai::MyPrompt")
        assertNotNull(t)
        assertEquals("prompt", t.subType)
    }

    @Test fun `promptTemplateOrNull returns null for output template`() {
        assertNull(loader().promptTemplateOrNull("acme::ai::MyOutput"))
    }

    @Test fun `outputTemplateOrNull returns null for prompt template`() {
        assertNull(loader().outputTemplateOrNull("acme::ai::MyPrompt"))
    }

    @Test fun `promptTemplateOrNull returns typed when present`() {
        val p = loader().promptTemplateOrNull("acme::ai::MyPrompt")
        assertNotNull(p)
        assertEquals("Payload", p.payloadRef)
    }
}
```

- [ ] **Step 3: Verify failure**

```bash
mvn -pl metadata-ktx test -q -Dtest=MetaObjectsTest 2>&1 | tail -10
```

Expected: FAIL — file doesn't exist.

- [ ] **Step 4: Write the impl**

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.MetaDataNotFoundException
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataLoaderRegistry
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.PromptTemplate

/** Lookup a MetaObject by name; returns null if not found. */
fun MetaDataLoader.metaObjectOrNull(name: String): MetaObject? =
    try { getMetaObjectByName(name) } catch (_: MetaDataNotFoundException) { null }

fun MetaDataLoaderRegistry.metaObjectOrNull(name: String): MetaObject? =
    try { getMetaObjectByName(name) } catch (_: MetaDataNotFoundException) { null }

/** Lookup a template (any subtype); null if not found or wrong type. */
fun MetaDataLoader.templateOrNull(name: String): MetaTemplate? =
    runCatching { root.getChildOfType("template", name) as? MetaTemplate }.getOrNull()

fun MetaDataLoader.promptTemplateOrNull(name: String): PromptTemplate? =
    templateOrNull(name) as? PromptTemplate

fun MetaDataLoader.outputTemplateOrNull(name: String): OutputTemplate? =
    templateOrNull(name) as? OutputTemplate
```

Note Kotlin's `object` is a reserved keyword — escape with backticks (`com.metaobjects.\`object\`.MetaObject`) when importing.

**If the actual API uses different method names** (e.g., `findMetaObject` returning `Optional<MetaObject>`), adjust the impl. The spec is locked on extension function names (`metaObjectOrNull`/`templateOrNull`/etc.) but the bodies can use whatever real Java API exists.

- [ ] **Step 5: Tests pass**

```bash
mvn -pl metadata-ktx test -q -Dtest=MetaObjectsTest 2>&1 | tail -5
```

Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/java/metadata-ktx
git commit -m "feat(metadata-ktx): MetaObjects — metaObjectOrNull + template subtype lookups"
```

---

### Task 4: `Fields.kt` — reified typed field access

**Files:**
- Create: `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/Fields.kt`
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/FieldsTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.field.StringField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.MetaField
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertFailsWith

class FieldsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.value": { "name": "P", "children": [
              { "field.string": { "name": "s" } },
              { "field.int":    { "name": "i" } }
          ] } }
        ]
      }
    }"""

    private fun obj() = loadString("t", fixture).metaObjectOrNull("acme::P")!!

    @Test fun `reified field returns typed value when present and right type`() {
        val s = obj().field<StringField>("s")
        assertNotNull(s)
    }

    @Test fun `reified field returns null when absent`() {
        assertNull(obj().field<StringField>("missing"))
    }

    @Test fun `reified field returns null when wrong subtype`() {
        assertNull(obj().field<IntegerField>("s"))
    }

    @Test fun `requireField throws when absent`() {
        assertFailsWith<Exception> { obj().requireField<StringField>("missing") }
    }

    @Test fun `fieldsOfType filters by subtype`() {
        assertEquals(1, obj().fieldsOfType<StringField>().size)
        assertEquals(1, obj().fieldsOfType<IntegerField>().size)
        assertEquals(2, obj().fieldsOfType<MetaField>().size)
    }
}
```

- [ ] **Step 2: Verify failure + write impl**

```bash
mvn -pl metadata-ktx test -q -Dtest=FieldsTest 2>&1 | tail -10
```

Expected: FAIL.

```kotlin
// Fields.kt
package com.metaobjects.metadata.ktx

import com.metaobjects.field.MetaField
import com.metaobjects.`object`.MetaObject

inline fun <reified T : MetaField> MetaObject.field(name: String): T? =
    runCatching { getMetaField(name) }.getOrNull() as? T

inline fun <reified T : MetaField> MetaObject.requireField(name: String): T =
    getMetaField(name) as T

inline fun <reified T : MetaField> MetaObject.fieldsOfType(): List<T> =
    metaFields.filterIsInstance<T>()
```

Verify `MetaObject.getMetaField(String)` and `MetaObject.metaFields` (Kotlin property derived from `getMetaFields()`) are the actual API. If method names differ, adjust.

- [ ] **Step 3: Tests pass + commit**

```bash
mvn -pl metadata-ktx test -q -Dtest=FieldsTest 2>&1 | tail -5
```

```bash
git add server/java/metadata-ktx
git commit -m "feat(metadata-ktx): Fields — reified field<T>() / requireField<T>() / fieldsOfType<T>()"
```

---

### Task 5: `Attrs.kt` — own-only attribute helpers

**Files:**
- Create: `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/Attrs.kt`
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/AttrsTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.metadata.ktx

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class AttrsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.value": { "name": "P", "children": [
              { "field.string": { "name": "s", "@maxLength": 100 } }
          ] } }
        ]
      }
    }"""

    private fun strField() = loadString("t", fixture).metaObjectOrNull("acme::P")!!.getMetaField("s")

    @Test fun `attrOrNull returns attr when present`() {
        assertNotNull(strField().attrOrNull("maxLength"))
    }

    @Test fun `attrOrNull returns null when absent`() {
        assertNull(strField().attrOrNull("nope"))
    }

    @Test fun `attrStringOrNull returns string value`() {
        assertEquals("100", strField().attrStringOrNull("maxLength"))
    }
}
```

- [ ] **Step 2: Verify failure + write impl**

```bash
mvn -pl metadata-ktx test -q -Dtest=AttrsTest 2>&1 | tail -10
```

```kotlin
// Attrs.kt
package com.metaobjects.metadata.ktx

import com.metaobjects.MetaData
import com.metaobjects.attr.MetaAttribute

fun MetaData.attrOrNull(name: String): MetaAttribute? =
    if (hasMetaAttr(name, false)) getMetaAttr(name, false) as MetaAttribute else null

fun MetaData.attrStringOrNull(name: String): String? =
    attrOrNull(name)?.valueAsString
```

Verify `MetaData.hasMetaAttr(name, includeInherited)` and `MetaData.getMetaAttr(name, includeInherited)` are the actual API + that `MetaAttribute.getValueAsString()` exists. If the spelling is different, fix.

- [ ] **Step 3: Tests pass + commit**

```bash
mvn -pl metadata-ktx test -q -Dtest=AttrsTest 2>&1 | tail -5
git add server/java/metadata-ktx
git commit -m "feat(metadata-ktx): Attrs — attrOrNull + attrStringOrNull"
```

---

### Task 6: `Identity.kt` — typed nullable IdentityGeneration enum

**Files:**
- Create: `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/Identity.kt`
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/IdentityTest.kt`

- [ ] **Step 1: Verify the Java MetaIdentity getter name**

`grep -n 'generation' server/java/metadata/src/main/java/com/metaobjects/identity/MetaIdentity.java` — find the property name. Could be `getGeneration()`, `getStrategy()`, etc.

- [ ] **Step 2: Write the failing test (adjust generation values to match Java's actual enum / string)**

```kotlin
package com.metaobjects.metadata.ktx

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class IdentityTest {

    private fun identityWithGeneration(gen: String) = loadString("t", """{
      "metadata.root": { "package": "acme", "children": [
        { "object.entity": { "name": "E", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "$gen" } }
        ] } }
      ] }
    }""").metaObjectOrNull("acme::E")!!.let { obj ->
        // Find the identity child — exact API name TBD per Java MetaIdentity
        obj.children.filterIsInstance<com.metaobjects.identity.MetaIdentity>().first()
    }

    @Test fun `INCREMENT maps`() { assertEquals(IdentityGeneration.INCREMENT, identityWithGeneration("increment").generationStrategy) }
    @Test fun `UUID maps`()      { assertEquals(IdentityGeneration.UUID,      identityWithGeneration("uuid").generationStrategy) }
    @Test fun `ASSIGNED maps`()  { assertEquals(IdentityGeneration.ASSIGNED,  identityWithGeneration("assigned").generationStrategy) }

    @Test fun `unknown value returns null`() {
        // Construct identity without @generation
        val identity = loadString("t", """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "E", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id" } }
            ] } }
          ] }
        }""").metaObjectOrNull("acme::E")!!.children.filterIsInstance<com.metaobjects.identity.MetaIdentity>().first()
        assertNull(identity.generationStrategy)
    }
}
```

- [ ] **Step 3: Verify failure + write impl**

```kotlin
// Identity.kt
package com.metaobjects.metadata.ktx

import com.metaobjects.identity.MetaIdentity

enum class IdentityGeneration { INCREMENT, UUID, ASSIGNED }

val MetaIdentity.generationStrategy: IdentityGeneration?
    get() = when (generation?.lowercase()) {
        "increment" -> IdentityGeneration.INCREMENT
        "uuid" -> IdentityGeneration.UUID
        "assigned" -> IdentityGeneration.ASSIGNED
        else -> null
    }
```

If the Java getter is `getGenerationStrategy()` (so Kotlin synthetic property is `generationStrategy`) — then the spec's extension property name COLLIDES with the synthetic. In that case, rename the Kotlin extension to `generationStrategyType` and update the test.

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl metadata-ktx test -q -Dtest=IdentityTest 2>&1 | tail -5
git add server/java/metadata-ktx
git commit -m "feat(metadata-ktx): Identity — IdentityGeneration enum + generationStrategy ext prop"
```

---

### Task 7: `Relationships.kt` — Cardinality + targetObjectOrNull

**Files:**
- Create: `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/Relationships.kt`
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/RelationshipsTest.kt`

- [ ] **Step 1: Verify Java MetaRelationship API**

Find the cardinality getter (likely `getCardinality()` returning String/enum) and `getTargetObject()` (which may throw `MetaDataNotFoundException` or return Optional). Adjust impl/test.

- [ ] **Step 2: Write the failing test**

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.relationship.MetaRelationship
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class RelationshipsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Author", "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
          ] } },
          { "object.entity": { "name": "Post", "children": [
              { "field.long": { "name": "id" } },
              { "field.long": { "name": "authorId" } },
              { "identity.primary": { "@fields": "id" } },
              { "relationship.composition": { "name": "author",
                  "@objectRef": "Author",
                  "@cardinality": "one" } }
          ] } }
        ]
      }
    }"""

    @Test fun `cardinality maps to enum`() {
        val rel = loadString("t", fixture).metaObjectOrNull("acme::Post")!!
            .children.filterIsInstance<MetaRelationship>().first()
        assertEquals(Cardinality.ONE, rel.cardinalityType)
    }

    @Test fun `targetObjectOrNull resolves`() {
        val rel = loadString("t", fixture).metaObjectOrNull("acme::Post")!!
            .children.filterIsInstance<MetaRelationship>().first()
        assertNotNull(rel.targetObjectOrNull)
        assertEquals("Author", rel.targetObjectOrNull?.shortName)  // verify shortName getter exists
    }
}
```

- [ ] **Step 3: Verify failure + write impl**

```kotlin
// Relationships.kt
package com.metaobjects.metadata.ktx

import com.metaobjects.MetaDataNotFoundException
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.MetaRelationship

enum class Cardinality { ONE, MANY }

val MetaRelationship.cardinalityType: Cardinality?
    get() = when (cardinality?.lowercase()) {
        "one" -> Cardinality.ONE
        "many" -> Cardinality.MANY
        else -> null
    }

val MetaRelationship.targetObjectOrNull: MetaObject?
    get() = try { targetObject } catch (_: MetaDataNotFoundException) { null }
```

If the Kotlin synthetic property `cardinality` collides with the spec name, rename to `cardinalityType` (which the spec already does). If `targetObject` getter throws a different exception, swap the catch.

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl metadata-ktx test -q -Dtest=RelationshipsTest 2>&1 | tail -5
git add server/java/metadata-ktx
git commit -m "feat(metadata-ktx): Relationships — Cardinality enum + targetObjectOrNull"
```

---

### Task 8: `Render.kt` — render builder + verify shortcut

**Files:**
- Create: `server/java/metadata-ktx/src/main/kotlin/com/metaobjects/metadata/ktx/Render.kt`
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/RenderTest.kt`

- [ ] **Step 1: Verify Java `RenderRequest` constructor signature**

`grep -n 'public record RenderRequest' server/java/render/src/main/java/com/metaobjects/render/RenderRequest.java` — confirm field order (template, ref, payload, provider, format, verify, maxChars).

- [ ] **Step 2: Write the failing test**

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.render.InMemoryProvider
import kotlin.test.Test
import kotlin.test.assertEquals

class RenderTest {

    @Test fun `render builder renders inline template`() {
        val out = render {
            template = "Hello {{name}}!"
            payload = mapOf("name" to "Ada")
            provider = InMemoryProvider(emptyMap())
        }
        assertEquals("Hello Ada!", out)
    }

    @Test fun `render builder via ref + provider`() {
        val out = render {
            ref = "g/s"
            payload = mapOf("name" to "Bob")
            provider = InMemoryProvider(mapOf("g/s" to "Hi {{name}}"))
        }
        assertEquals("Hi Bob", out)
    }

    @Test fun `render builder default format is text`() {
        val out = render {
            template = "{{value}}"
            payload = mapOf("value" to "<b>raw</b>")
            provider = InMemoryProvider(emptyMap())
        }
        assertEquals("<b>raw</b>", out)
    }

    @Test fun `render builder honors format html`() {
        val out = render {
            template = "{{value}}"
            payload = mapOf("value" to "<b>raw</b>")
            provider = InMemoryProvider(emptyMap())
            format = "html"
        }
        assertEquals("&lt;b&gt;raw&lt;/b&gt;", out)
    }
}
```

- [ ] **Step 3: Verify failure + write impl**

```kotlin
// Render.kt
package com.metaobjects.metadata.ktx

import com.metaobjects.render.PayloadField
import com.metaobjects.render.Provider
import com.metaobjects.render.RenderRequest
import com.metaobjects.render.Renderer
import com.metaobjects.render.Verify
import com.metaobjects.render.VerifyError
import com.metaobjects.render.VerifyOptions

/** Render via an explicit Java RenderRequest. */
fun render(request: RenderRequest): String = Renderer().render(request)

/** Property-bag builder for RenderRequest. */
class RenderBuilder {
    var template: String? = null
    var ref: String? = null
    var payload: Any? = null
    var provider: Provider? = null
    var format: String = "text"
    var verify: List<PayloadField>? = null
    var maxChars: Int? = null

    fun build(): RenderRequest = RenderRequest(
        template, ref, payload, provider, format, verify, maxChars
    )
}

inline fun render(block: RenderBuilder.() -> Unit): String =
    render(RenderBuilder().apply(block).build())

/** Verify shortcut. */
fun verify(
    templateText: String,
    fields: List<PayloadField>,
    options: VerifyOptions = VerifyOptions.empty()
): List<VerifyError> = Verify.check(templateText, fields, options)
```

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl metadata-ktx test -q -Dtest=RenderTest 2>&1 | tail -5
git add server/java/metadata-ktx
git commit -m "feat(metadata-ktx): Render — render { ... } builder + verify(...) shortcut"
```

---

### Task 9: Integration smoke + README

**Files:**
- Create: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/README.kt` (compile-checked code samples)
- Create: `server/java/metadata-ktx/src/test/resources/meta.demo.json` (small test fixture)
- Modify: `server/java/metadata-ktx/README.md` (populate with usage examples)

- [ ] **Step 1: Add test fixture**

`server/java/metadata-ktx/src/test/resources/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "acme::demo",
    "children": [
      { "object.value": { "name": "Author", "children": [
          { "field.string": { "name": "name" } }
      ] } },
      { "template.prompt": { "name": "WelcomePrompt",
          "@payloadRef": "Author",
          "@textRef": "demo/welcome",
          "@format": "text" } }
    ]
  }
}
```

- [ ] **Step 2: Write compile-checked README examples**

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.render.InMemoryProvider
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * Code samples that appear in README.md. Each public sample is exercised here so
 * README drift is caught at compile-time (matches the omdb-ktx README.kt pattern).
 */
class README {

    @Test fun `load from classpath resource and navigate`() {
        val loader = loadResources("demo", listOf("meta.demo.json"))
        val author = loader.metaObjectOrNull("acme::demo::Author")
        assertNotNull(author)
        assertEquals("value", author.subType)
    }

    @Test fun `look up a prompt template`() {
        val loader = loadResources("demo", listOf("meta.demo.json"))
        val prompt = loader.promptTemplateOrNull("acme::demo::WelcomePrompt")
        assertNotNull(prompt)
        assertEquals("Author", prompt.payloadRef)
    }

    @Test fun `render a prompt via the builder`() {
        val out = render {
            template = "Hello {{name}}, welcome!"
            payload = mapOf("name" to "Ada")
            provider = InMemoryProvider(emptyMap())
        }
        assertEquals("Hello Ada, welcome!", out)
    }
}
```

- [ ] **Step 3: Populate the README**

`server/java/metadata-ktx/README.md`:

```markdown
# MetaObjects :: Metadata Kotlin Facade (`metadata-ktx`)

A thin Kotlin extension layer over the Java MetaObjects engine.
No forking, no reimplementation — just idiomatic Kotlin syntax on top of the existing Java API.

## Dependency

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata-ktx</artifactId>
    <version>${project.version}</version>
</dependency>
```

## Loading metadata

```kotlin
import com.metaobjects.metadata.ktx.*

// From classpath resources
val loader = loadResources("demo", listOf("meta.demo.json"))

// From a directory
val dirLoader = loadDirectory("app", Path.of("./metadata"))

// From an inline string
val inlineLoader = loadString("test", """{ "metadata.root": { "package": "x", "children": [] } }""")
```

## Navigating metadata

```kotlin
// Null-returning lookups (idiomatic Kotlin)
val author = loader.metaObjectOrNull("acme::demo::Author")  // returns null if not found

// Reified typed field access
val name = author?.field<StringField>("name")   // null if absent or wrong type
val required = author!!.requireField<StringField>("name")  // throws if absent

// Typed nullable enums
val rel = ...  // some MetaRelationship
val cardinality: Cardinality? = rel.cardinalityType  // typed enum; null if absent/unknown
```

## Template + render (FR-004)

```kotlin
val prompt = loader.promptTemplateOrNull("acme::demo::WelcomePrompt")
println(prompt?.payloadRef)   // "Author"

// Render via the Kotlin builder
val out = render {
    template = "Hello {{name}}, welcome!"
    payload = mapOf("name" to "Ada")
    provider = InMemoryProvider(emptyMap())
}
// out == "Hello Ada, welcome!"

// Render via a ref + filesystem provider
val rendered = render {
    ref = "lobby/welcome"
    payload = mapOf("name" to "Bob")
    provider = FilesystemProvider(Path.of("./prompts"))
    format = "html"
}
```

## Patterns not wrapped (Java works fine from Kotlin)

- **Custom MetaObject / MetaField subtypes:** `class MyType : EntityMetaObject("MyType")` — Kotlin subclasses Java directly.
- **Custom Provider:** `class MyProvider : Provider { override fun resolve(ref: String): String? = ... }`
- **Custom MetaDataSource:** same pattern.
- **MetaObject / MetaField mutation:** the Java mutator API (`addChild`, `addMetaAttribute`) reads fine from Kotlin.
- **Registry builder:** Java's `MetaDataRegistry.registerType(MyType::class.java) { def -> def.type(...)... }` is already lambda-friendly.

## Status

`metaobjects-metadata-ktx` 7.0.0-SNAPSHOT. Mirrors the `metaobjects-omdb-ktx` Kotlin facade pattern.
```

- [ ] **Step 4: Run README + full module tests**

```bash
mvn -pl metadata-ktx test -q 2>&1 | tail -5
```

Expected: all tests PASS (Tasks 2–8 + README.kt = ~25+ tests).

- [ ] **Step 5: Run full reactor**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java && mvn test -q 2>&1 | grep -E 'BUILD|Tests run:' | tail -3
```

Expected: BUILD SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add server/java/metadata-ktx
git commit -m "test(metadata-ktx): README.kt compile-checked samples + meta.demo.json fixture; README populated"
```

---

### Task 10: Review gate + merge to main

- [ ] **Step 1: Dispatch code-reviewer + code-simplifier in parallel**

Code-reviewer focus:
- All Kotlin files under `server/java/metadata-ktx/src/main/kotlin/`
- API surface vs spec
- Wrap-where-friction discipline (any wrappers that don't add value)
- Cross-port naming (loadDirectory/loadUris/etc.)
- Render builder safety (does build() reject missing required fields?)

Code-simplifier scope: same files.

- [ ] **Step 2: Apply Important findings, re-run full reactor**

- [ ] **Step 3: Merge to main**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git fetch origin main
git merge --no-ff origin/main -m "Merge origin/main into worktree-metadata-ktx (pre-merge sync)"
cd server/java && mvn test -q
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git push -u origin worktree-metadata-ktx

git -C /home/doug/Development/metaobjects pull --ff-only origin main
git -C /home/doug/Development/metaobjects merge --no-ff worktree-metadata-ktx \
  -m "Merge metadata-ktx — Kotlin facade over Java MetaObjects + FR-004 render"
git -C /home/doug/Development/metaobjects push origin main
```

---

## Self-Review

**Spec coverage:**
- §3 Module + coords → Task 1
- §4 File layout → Tasks 1–8
- §5.1 Loader.kt → Task 2
- §5.2 MetaObjects.kt → Task 3
- §5.3 Fields.kt → Task 4
- §5.4 Attrs.kt → Task 5
- §5.5 Identity.kt → Task 6
- §5.6 Relationships.kt → Task 7
- §5.7 Render.kt → Task 8
- §7 Testing → Task 9 (README.kt + integration smoke)

**Placeholder scan:** zero TBD/TODO/"add appropriate" patterns. The plan has explicit "verify API at impl time" notes where Java API names are uncertain — that's a real implementer instruction, not a placeholder.

**Type consistency:** Function names match across plan and spec (`metaObjectOrNull`, `templateOrNull`, `promptTemplateOrNull`, `outputTemplateOrNull`, `field<T>`, `requireField<T>`, `fieldsOfType<T>`, `attrOrNull`, `attrStringOrNull`, `generationStrategy`, `cardinalityType`, `targetObjectOrNull`, `render`, `verify`). Enum names match (`IdentityGeneration`, `Cardinality`).

---

## Execution

**Subagent-Driven Development** — single implementer subagent runs Tasks 1–9 sequentially (all tasks small and tightly coupled). Controller dispatches reviewer + simplifier afterward for the per-Phase gate, then merges.
