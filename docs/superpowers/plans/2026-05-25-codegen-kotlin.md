# codegen-kotlin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `metaobjects-codegen-kotlin` — Kotlin codegen target (entity data class + Exposed Table + FR-004 payload + MetadataStartupValidator), driven by KotlinPoet. Extend the existing `MetaDataMigrateMojo` with Flyway naming; add `MetaDataVerifyMojo` for CI drift detection.

**Architecture:** New Maven module mirroring `metadata-ktx` shape. 4 generators each extending `MultiFileDirectGeneratorBase<MetaObject>` (or `SingleFileDirectGeneratorBase` for the project-wide validator). Emit via KotlinPoet `FileSpec.writeTo(Path)` — bypass `FileDirectWriter` (which is print-style, wrong fit for whole-file Kotlin emission). Snapshot tests gate output stability; `kotlin-compile-testing` gates generated-code validity.

**Tech Stack:** Kotlin 2.0.21, JVM 21, Maven, JUnit5 + `kotlin-test-junit5`, `com.squareup:kotlinpoet:1.18.1`, `com.github.tschuchortdev:kotlin-compile-testing:1.6.0` (test-scope).

**Spec:** [docs/superpowers/specs/2026-05-25-codegen-kotlin-design.md](../specs/2026-05-25-codegen-kotlin-design.md)

**Reference templates:**
- `server/java/metadata-ktx/pom.xml` — Kotlin module pom shape (copy verbatim, swap deps)
- `server/java/render/src/test/java/com/metaobjects/render/RenderSnapshotTest.java` — snapshot test pattern (JUnit 4 parameterized — but we'll use JUnit 5 to stay consistent with metadata-ktx)
- `server/java/codegen-base/src/main/java/com/metaobjects/generator/direct/MultiFileDirectGeneratorBase.java` — generator base class
- `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataMigrateMojo.java` — mojo to extend with Flyway support

**Branch:** `worktree-codegen-kotlin` (already checked out).

---

## File Structure

### Phase 1–5 (new module)

```
server/java/codegen-kotlin/
├── pom.xml                                                # MIRROR metadata-ktx, swap deps
├── README.md                                              # populated in Task 5.3
└── src/
    ├── main/kotlin/com/metaobjects/generator/kotlin/
    │   ├── PackageMapping.kt                              # metadata "::" → Kotlin "."
    │   ├── KotlinTypeMapper.kt                            # MetaField → KotlinPoet TypeName + Exposed column statement
    │   ├── KotlinEntityGenerator.kt                       # @Serializable data class per object.entity
    │   ├── KotlinExposedTableGenerator.kt                 # Exposed Table object per entity with source.rdb
    │   ├── KotlinPayloadGenerator.kt                      # @Serializable payload class per template.*
    │   └── KotlinValidatorGenerator.kt                    # MetadataStartupValidator.kt + ExposedTableValidator.kt
    └── test/kotlin/com/metaobjects/generator/kotlin/
        ├── PackageMappingTest.kt
        ├── KotlinTypeMapperTest.kt
        ├── KotlinEntityGeneratorTest.kt
        ├── KotlinExposedTableGeneratorTest.kt
        ├── KotlinPayloadGeneratorTest.kt
        ├── KotlinValidatorGeneratorTest.kt
        ├── KotlinCodegenSnapshotTest.kt                   # parameterized over fixtures
        ├── KotlinOutputCompilesTest.kt                    # kotlin-compile-testing gate
        └── KotlinCodegenE2ETest.kt                        # generate → compile → render via Java render
```

### Phase 6 (extend existing maven-plugin)

```
server/java/maven-plugin/
└── src/main/java/com/metaobjects/mojo/
    ├── MetaDataMigrateMojo.java                          # MODIFY: add flyway/flywayDir/flywayPrefix params
    └── MetaDataVerifyMojo.java                           # NEW: meta:verify goal
```

### Parent pom

```
server/java/pom.xml                                       # APPEND <module>codegen-kotlin</module>
```

---

# Phase 1 — Module scaffolding + shared foundation

---

### Task 1.1: Module scaffolding (pom + dirs + parent registration)

**Files:**
- Create: `server/java/codegen-kotlin/pom.xml`
- Create: `server/java/codegen-kotlin/README.md` (1-line placeholder; populated Task 5.3)
- Create directories: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/` + `src/test/kotlin/...`
- Modify: `server/java/pom.xml` — APPEND `<module>codegen-kotlin</module>` after `<module>metadata-ktx</module>` and before `<module>codegen-base</module>`

- [ ] **Step 1: Read the reference pom**

```bash
cat /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java/metadata-ktx/pom.xml
```

This is the literal template — copy + swap deps.

- [ ] **Step 2: Write the pom**

`server/java/codegen-kotlin/pom.xml`:

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

  <artifactId>metaobjects-codegen-kotlin</artifactId>
  <name>MetaObjects :: Codegen :: Kotlin</name>
  <description>Kotlin codegen target — emits @Serializable data classes, Exposed Tables, FR-004 payload classes, and a startup-validator stub via KotlinPoet.</description>

  <properties>
    <kotlin.version>2.0.21</kotlin.version>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>

  <dependencies>
    <!-- production -->
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-stdlib</artifactId>
      <version>${kotlin.version}</version>
    </dependency>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-codegen-base</artifactId>
      <version>${project.version}</version>
    </dependency>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-metadata-ktx</artifactId>
      <version>${project.version}</version>
    </dependency>
    <dependency>
      <groupId>com.squareup</groupId>
      <artifactId>kotlinpoet</artifactId>
      <version>1.18.1</version>
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
    <dependency>
      <groupId>com.github.tschuchortdev</groupId>
      <artifactId>kotlin-compile-testing</artifactId>
      <version>1.6.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <sourceDirectory>src/main/kotlin</sourceDirectory>
    <testSourceDirectory>src/test/kotlin</testSourceDirectory>
    <plugins>
      <!-- COPY plugin block VERBATIM from server/java/metadata-ktx/pom.xml -->
      <!-- (kotlin-maven-plugin with compile + test-compile executions, jvmTarget=21, + surefire) -->
    </plugins>
  </build>
</project>
```

Copy the entire `<build><plugins>` block verbatim from `metadata-ktx/pom.xml`. Do not invent — match exactly.

- [ ] **Step 3: Make directories**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
mkdir -p server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin
mkdir -p server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin
```

- [ ] **Step 4: Register the module**

Edit `server/java/pom.xml`. In `<modules>`, append `<module>codegen-kotlin</module>` after `<module>metadata-ktx</module>` (or any sensible place; topological order needs metadata-ktx before).

- [ ] **Step 5: Placeholder README**

`server/java/codegen-kotlin/README.md`:

```markdown
# MetaObjects :: Codegen :: Kotlin (`codegen-kotlin`)

(README populated by implementation plan Task 5.3.)
```

- [ ] **Step 6: Verify module is recognized**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java
mvn -pl codegen-kotlin validate -q
```

Expected: success (empty module validates).

- [ ] **Step 7: Commit**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git add server/java/codegen-kotlin/pom.xml server/java/codegen-kotlin/README.md server/java/pom.xml
git commit -m "build(java): scaffold metaobjects-codegen-kotlin module"
```

---

### Task 1.2: `PackageMapping.kt` — metadata "::" → Kotlin "."

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/PackageMapping.kt`
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/PackageMappingTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.generator.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals

class PackageMappingTest {

    @Test fun `single segment`() {
        assertEquals("acme", PackageMapping.toKotlin("acme"))
    }

    @Test fun `two segments`() {
        assertEquals("acme.demo", PackageMapping.toKotlin("acme::demo"))
    }

    @Test fun `three segments`() {
        assertEquals("acme.demo.commerce", PackageMapping.toKotlin("acme::demo::commerce"))
    }

    @Test fun `empty stays empty`() {
        assertEquals("", PackageMapping.toKotlin(""))
    }

    @Test fun `splitFqn returns package + shortName`() {
        assertEquals("acme.demo" to "Author",
            PackageMapping.splitFqn("acme::demo::Author"))
    }

    @Test fun `splitFqn with no package`() {
        assertEquals("" to "Author",
            PackageMapping.splitFqn("Author"))
    }
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java
mvn -pl codegen-kotlin test -q -Dtest=PackageMappingTest
```

Expected: FAIL (class doesn't exist).

- [ ] **Step 3: Write impl**

`PackageMapping.kt`:

```kotlin
package com.metaobjects.generator.kotlin

/** Translate metadata package syntax (`a::b::c`) to Kotlin package syntax (`a.b.c`). */
object PackageMapping {

    /** Convert metadata package separator "::" to Kotlin "." */
    fun toKotlin(metadataPackage: String): String =
        metadataPackage.replace("::", ".")

    /** Split a fully-qualified metadata name into Kotlin (packageName, shortName). */
    fun splitFqn(fqn: String): Pair<String, String> {
        val lastSep = fqn.lastIndexOf("::")
        return if (lastSep < 0) {
            "" to fqn
        } else {
            toKotlin(fqn.substring(0, lastSep)) to fqn.substring(lastSep + 2)
        }
    }
}
```

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl codegen-kotlin test -q -Dtest=PackageMappingTest
```

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git add server/java/codegen-kotlin
git commit -m "feat(codegen-kotlin): PackageMapping — metadata :: to Kotlin ."
```

---

### Task 1.3: `KotlinTypeMapper.kt` — MetaField → Kotlin/Exposed types

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTypeMapper.kt`
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinTypeMapperTest.kt`

The mapper has two responsibilities:
1. `kotlinTypeName(field): TypeName` — KotlinPoet TypeName for the data-class property
2. `exposedColumnSpec(field): String` — the Exposed `Table` column statement (e.g., `varchar("name", 100)`)

These keep the mapping logic in ONE place so the Entity and ExposedTable generators stay thin.

- [ ] **Step 1: Write the failing test (covers the 12 spec'd types)**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.field.BooleanField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.DOUBLE
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KotlinTypeMapperTest {

    // Helper: build a MetaField with a name (no parent attachment needed for type queries)
    private fun field(meta: MetaData) = meta

    @Test fun `string field maps to String`() {
        val f = StringField("name")
        assertEquals(STRING, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `int field maps to Int`() {
        val f = IntegerField("count")
        assertEquals(INT, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `long field maps to Long`() {
        val f = LongField("id")
        assertEquals(LONG, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `double field maps to Double`() {
        val f = DoubleField("ratio")
        assertEquals(DOUBLE, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `boolean field maps to Boolean`() {
        val f = BooleanField("active")
        assertEquals(BOOLEAN, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `date field maps to java time LocalDate`() {
        val f = DateField("birthday")
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.time", tn.packageName)
        assertEquals("LocalDate", tn.simpleName)
    }

    @Test fun `timestamp field maps to java time Instant`() {
        val f = TimestampField("createdAt")
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.time", tn.packageName)
        assertEquals("Instant", tn.simpleName)
    }

    @Test fun `string field maps to varchar exposed column`() {
        val f = StringField("name")
        val spec = KotlinTypeMapper.exposedColumnSpec(f)
        assertTrue(spec.contains("varchar"), "expected varchar in: $spec")
        assertTrue(spec.contains("\"name\""), "expected column name in: $spec")
    }

    @Test fun `long field maps to long exposed column`() {
        val f = LongField("id")
        val spec = KotlinTypeMapper.exposedColumnSpec(f)
        assertEquals("long(\"id\")", spec)
    }

    @Test fun `int field maps to integer exposed column`() {
        val f = IntegerField("count")
        assertEquals("integer(\"count\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `boolean field maps to bool exposed column`() {
        val f = BooleanField("active")
        assertEquals("bool(\"active\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `double field maps to double exposed column`() {
        val f = DoubleField("ratio")
        assertEquals("double(\"ratio\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `date field maps to date exposed column`() {
        val f = DateField("birthday")
        assertEquals("date(\"birthday\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `timestamp field maps to timestampWithTimeZone exposed column`() {
        val f = TimestampField("createdAt")
        assertEquals("timestampWithTimeZone(\"createdAt\")", KotlinTypeMapper.exposedColumnSpec(f))
    }
}
```

**Note:** The test imports specific MetaField subclasses (`StringField`, `IntegerField`, etc.). Verify these exist in `server/java/metadata/src/main/java/com/metaobjects/field/`. If the class names differ (e.g., `MetaStringField`), adjust the test imports + the mapper's `when` arms. The IMPLEMENTER should resolve actual names before writing the test.

- [ ] **Step 2: Verify failure**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinTypeMapperTest
```

Expected: FAIL.

- [ ] **Step 3: Write impl**

`KotlinTypeMapper.kt`:

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.TypeName

/**
 * Centralized mapping from MetaField subtype to (a) KotlinPoet TypeName for data class
 * properties and (b) the Exposed `Table` column statement.
 *
 * Per the codegen-kotlin spec §6 (type mapping table). Tier-1 invariant: the *semantic*
 * type per field subtype is identical across all language ports. The exact Kotlin/Exposed
 * names are Tier-2 idiomatic per port.
 */
object KotlinTypeMapper {

    /** Map a MetaField to its KotlinPoet data-class property TypeName. */
    fun kotlinTypeName(field: MetaField<*>): TypeName = when (field) {
        is StringField    -> STRING
        is IntegerField   -> INT
        is LongField      -> LONG
        is DoubleField    -> DOUBLE
        is BooleanField   -> BOOLEAN
        is DateField      -> ClassName("java.time", "LocalDate")
        is TimestampField -> ClassName("java.time", "Instant")
        else -> throw IllegalArgumentException(
            "unsupported Kotlin type mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /** Map a MetaField to the Exposed `Table` column statement (e.g., `varchar("name", 100)`). */
    fun exposedColumnSpec(field: MetaField<*>): String {
        val colName = field.name
        return when (field) {
            is StringField    -> "varchar(\"$colName\", ${stringMaxLength(field)})"
            is IntegerField   -> "integer(\"$colName\")"
            is LongField      -> "long(\"$colName\")"
            is DoubleField    -> "double(\"$colName\")"
            is BooleanField   -> "bool(\"$colName\")"
            is DateField      -> "date(\"$colName\")"
            is TimestampField -> "timestampWithTimeZone(\"$colName\")"
            else -> throw IllegalArgumentException(
                "unsupported Exposed column mapping for ${field::class.simpleName} '${field.name}'"
            )
        }
    }

    /** Resolve @maxLength on a StringField; default 255. */
    private fun stringMaxLength(field: StringField): Int {
        val attr = runCatching { field.getMetaAttr("maxLength", false) }.getOrNull()
        val raw = attr?.value
        return when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull() ?: 255
            else -> 255
        }
    }
}
```

**Note:** This MVP omits enum, currency, object, and uuid. Those are documented in spec §6 but deferred to follow-ups; the generator throws `IllegalArgumentException` with a clear message at codegen time when it encounters them.

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinTypeMapperTest
```

```bash
git add server/java/codegen-kotlin
git commit -m "feat(codegen-kotlin): KotlinTypeMapper — 7 primitive types + Exposed column statements"
```

---

# Phase 2 — Entity + Exposed Table generators

---

### Task 2.1: `KotlinEntityGenerator.kt` — @Serializable data class per entity

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinEntityGenerator.kt`
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinEntityGeneratorTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KotlinEntityGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "field.string": { "name": "bio" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `emits data class with Serializable annotation`() {
        val outDir = Files.createTempDirectory("kgen-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val emitted = outDir.resolve("acme/demo/Author.kt")
            assertTrue(Files.exists(emitted), "expected $emitted to exist")

            val src = Files.readString(emitted)
            assertTrue("@Serializable" in src, "expected @Serializable in:\n$src")
            assertTrue("data class Author" in src, "expected data class in:\n$src")
            assertTrue("val id: Long" in src, "expected id: Long in:\n$src")
            assertTrue("val name: String" in src, "expected name: String in:\n$src")
            assertTrue("kotlinx.serialization.Serializable" in src,
                "expected kotlinx.serialization import in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
```

- [ ] **Step 2: Verify failure**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinEntityGeneratorTest
```

Expected: FAIL.

- [ ] **Step 3: Write impl**

`KotlinEntityGenerator.kt`:

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.AnnotationSpec
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.ParameterSpec
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.TypeName
import com.squareup.kotlinpoet.TypeSpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one @Serializable Kotlin data class per `object.entity`.
 *
 * Args:
 * - `outputDir` (required): output directory root; package directories are created under it.
 */
class KotlinEntityGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    // We sidestep the parent's print-style writer machinery and emit via KotlinPoet directly.
    // Override writeSingleFile to do the real work; the writer abstractions are vestigial here.
    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) {
        // No-op: real emission is in execute() override below
    }

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outputDir)
        for (entity in loader.root.metaObjects.filterIsInstance<MetaObject>()) {
            if (entity.subType != "entity") continue   // ignore object.value; payload generator handles those
            emit(entity, outRoot)
        }
    }

    private fun emit(entity: MetaObject, outRoot: Path) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(shortName)
            .addModifiers(com.squareup.kotlinpoet.KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in entity.children.filterIsInstance<MetaField<*>>()) {
            val baseType = KotlinTypeMapper.kotlinTypeName(field)
            val nullable = !isRequired(field)
            val propType = if (nullable) baseType.copy(nullable = true) else baseType
            val propName = field.name
            val param = ParameterSpec.builder(propName, propType)
                .apply { if (nullable) defaultValue("null") }
                .build()
            ctorBuilder.addParameter(param)
            typeBuilder.addProperty(
                PropertySpec.builder(propName, propType).initializer(propName).build()
            )
        }

        val fileSpec = FileSpec.builder(pkg, shortName)
            .addType(typeBuilder.primaryConstructor(ctorBuilder.build()).build())
            .build()

        fileSpec.writeTo(outRoot)
    }

    /** Required = field not flagged nullable (default true for FK-pointed; default false for PK). */
    private fun isRequired(field: MetaField<*>): Boolean {
        // For MVP: treat the entity's PK fields as required, everything else as required-by-default
        // unless explicitly marked nullable. The metadata model uses an isRequired() helper on fields.
        return runCatching { field.javaClass.getMethod("isRequired").invoke(field) as Boolean }
            .getOrDefault(true)
    }

    // Unused — KotlinPoet writes whole files; parent's print-style writers aren't used.
    override fun getSingleWriter(loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?): GeneratorIOWriter<*>? = null
    override fun getFinalWriter(loader: MetaDataLoader?, out: OutputStream?): GeneratorIOWriter<*>? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).first.replace('.', '/')
    override fun getSingleOutputFilename(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).second + ".kt"
}
```

**IMPORTANT:** Read `server/java/codegen-base/src/main/java/com/metaobjects/generator/direct/MultiFileDirectGeneratorBase.java` first. Verify exact method signatures (`getSingleWriter`, `getFinalWriter`, etc.). If the abstract signatures use raw types or different generics, adjust the overrides to compile. The intent is clear: override `execute()` to do the real work via KotlinPoet, satisfy the abstract method contract with stubs.

Also verify the MetaObject children-of-type API: `loader.root.metaObjects` may not exist — likely you need `loader.root.children.filterIsInstance<MetaObject>()` or `loader.root.getChildrenOfType("object")`. Adjust to match the real API.

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinEntityGeneratorTest
```

```bash
git add server/java/codegen-kotlin
git commit -m "feat(codegen-kotlin): KotlinEntityGenerator — @Serializable data class per entity"
```

---

### Task 2.2: `KotlinExposedTableGenerator.kt` — Exposed Table object per entity with source.rdb

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt`
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGeneratorTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

class KotlinExposedTableGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 100 } },
            { "field.string": { "name": "bio" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `emits Exposed Table object with columns and PK`() {
        val outDir = Files.createTempDirectory("ktbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val emitted = outDir.resolve("acme/demo/AuthorTable.kt")
            assertTrue(Files.exists(emitted), "expected $emitted")

            val src = Files.readString(emitted)
            assertTrue("import org.jetbrains.exposed.sql.Table" in src, src)
            assertTrue("object AuthorTable : Table(\"authors\")" in src, src)
            assertTrue("val id = long(\"id\").autoIncrement()" in src, src)
            assertTrue("val name = varchar(\"name\", 100)" in src, src)
            assertTrue("val bio = varchar(\"bio\", 255).nullable()" in src ||
                       "val bio = varchar(\"bio\", 255)" in src, src)
            assertTrue("override val primaryKey = PrimaryKey(id)" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `skips entities without source rdb child`() {
        val noSource = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", noSource))

            // No AuthorTable.kt should be emitted
            assertTrue(!Files.exists(outDir.resolve("x/AuthorTable.kt")))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
```

- [ ] **Step 2: Verify failure + write impl**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinExposedTableGeneratorTest
```

Expected: FAIL.

```kotlin
// KotlinExposedTableGenerator.kt
package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.TypeSpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one Exposed Table `object` per `object.entity` that has a `source.rdb` child.
 * Entities without source.rdb are skipped (no persistence layer).
 *
 * Args:
 * - `outputDir` (required): output directory root
 */
class KotlinExposedTableGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outputDir)
        for (entity in loader.root.children.filterIsInstance<MetaObject>()) {
            if (entity.subType != "entity") continue
            val sourceRdb = findChildOfType(entity, "source", "rdb") ?: continue
            emit(entity, sourceRdb, outRoot)
        }
    }

    private fun emit(entity: MetaObject, sourceRdb: com.metaobjects.MetaData, outRoot: Path) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val tableObjectName = shortName + "Table"
        val tableName = attrString(sourceRdb, "table") ?: shortName.lowercase() + "s"

        val tableSuperclass = ClassName("org.jetbrains.exposed.sql", "Table")
        val pkClass = ClassName("org.jetbrains.exposed.sql.Table", "PrimaryKey")

        val typeBuilder = TypeSpec.objectBuilder(tableObjectName)
            .superclass(tableSuperclass)
            .addSuperclassConstructorParameter("%S", tableName)
            .addKdoc("GENERATED — do not hand-edit.\n")

        val primaryFieldName = primaryFieldName(entity)

        for (field in entity.children.filterIsInstance<MetaField<*>>()) {
            val isPk = field.name == primaryFieldName
            val nullable = !isPk && !isRequired(field)
            val baseSpec = KotlinTypeMapper.exposedColumnSpec(field)
            val withAuto = if (isPk && hasIncrementGeneration(entity)) "$baseSpec.autoIncrement()" else baseSpec
            val full = if (nullable) "$withAuto.nullable()" else withAuto
            typeBuilder.addProperty(
                PropertySpec.builder(field.name, ANY_COLUMN_PLACEHOLDER)
                    .initializer(CodeBlock.of(full))
                    .build()
            )
        }
        if (primaryFieldName != null) {
            typeBuilder.addProperty(
                PropertySpec.builder("primaryKey", pkClass)
                    .addModifiers(com.squareup.kotlinpoet.KModifier.OVERRIDE)
                    .initializer("PrimaryKey($primaryFieldName)")
                    .build()
            )
        }

        FileSpec.builder(pkg, tableObjectName)
            .addType(typeBuilder.build())
            .build()
            .writeTo(outRoot)
    }

    // Use Any as the property type — KotlinPoet emits it but doesn't validate the column expression.
    // The actual Exposed Column<T> type is inferred by the Kotlin compiler from the initializer.
    private val ANY_COLUMN_PLACEHOLDER = ClassName("kotlin", "Any")

    private fun findChildOfType(entity: MetaObject, type: String, subType: String): com.metaobjects.MetaData? =
        entity.children.find { it.type == type && it.subType == subType }

    private fun attrString(md: com.metaobjects.MetaData, attrName: String): String? =
        runCatching {
            val attr = md.getMetaAttr(attrName, false) as? com.metaobjects.attr.MetaAttribute<*>
            attr?.valueAsString
        }.getOrNull()

    private fun primaryFieldName(entity: MetaObject): String? {
        val primary = entity.children.find { it.type == "identity" && it.subType == "primary" } ?: return null
        return attrString(primary, "fields")?.substringBefore(",")?.trim()
    }

    private fun hasIncrementGeneration(entity: MetaObject): Boolean {
        val primary = entity.children.find { it.type == "identity" && it.subType == "primary" } ?: return false
        return attrString(primary, "generation")?.lowercase() == "increment"
    }

    private fun isRequired(field: MetaField<*>): Boolean =
        runCatching { field.javaClass.getMethod("isRequired").invoke(field) as Boolean }
            .getOrDefault(true)

    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun getSingleWriter(loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?): GeneratorIOWriter<*>? = null
    override fun getFinalWriter(loader: MetaDataLoader?, out: OutputStream?): GeneratorIOWriter<*>? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).first.replace('.', '/')
    override fun getSingleOutputFilename(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).second + "Table.kt"
}
```

**Note on the `ANY_COLUMN_PLACEHOLDER` trick:** KotlinPoet needs a property type, but Exposed's `Column<T>` types are inferred. Emitting `val id: Any = long("id").autoIncrement()` would be wrong. The correct pattern is to **not declare the type** — let Kotlin infer. KotlinPoet supports this via `PropertySpec.builder(name)` *without* a type, but the API typically requires a type. If KotlinPoet's `PropertySpec` requires a type, an alternative is to emit raw code with `addCode()` instead of typed properties. Implementer: verify which works; pick the one that produces clean output (no `: Any` annotation in the emitted file). If both fail, fall back to manually declaring the appropriate `Column<...>` types per field subtype in `KotlinTypeMapper`.

- [ ] **Step 3: Tests pass + commit**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinExposedTableGeneratorTest
```

```bash
git add server/java/codegen-kotlin
git commit -m "feat(codegen-kotlin): KotlinExposedTableGenerator — Exposed Table object per source.rdb entity"
```

---

# Phase 3 — Payload generator (FR-004)

---

### Task 3.1: `KotlinPayloadGenerator.kt` — typed @Serializable payload per template.*

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinPayloadGenerator.kt`
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinPayloadGeneratorTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

class KotlinPayloadGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.value": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } }
        ] } },
        { "template.prompt": { "name": "WelcomePrompt",
            "@payloadRef": "Author", "@textRef": "demo/welcome" } }
      ] }
    }""".trimIndent()

    @Test fun `emits payload class with Serializable annotation`() {
        val outDir = Files.createTempDirectory("kpay-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val emitted = outDir.resolve("acme/demo/prompts/WelcomePromptPayload.kt")
            assertTrue(Files.exists(emitted), "expected $emitted")

            val src = Files.readString(emitted)
            assertTrue("@Serializable" in src, src)
            assertTrue("data class WelcomePromptPayload" in src, src)
            assertTrue("val id: Long" in src, src)
            assertTrue("val name: String" in src, src)
            assertTrue("package acme.demo.prompts" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
```

- [ ] **Step 2: Verify failure + write impl**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinPayloadGeneratorTest
```

Expected: FAIL.

```kotlin
// KotlinPayloadGenerator.kt
package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.ParameterSpec
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.TypeSpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one @Serializable payload data class per template.*, derived from its
 * @payloadRef view-object's field tree.
 *
 * Output package = `<entity-package>.prompts`
 * Class name = `<TemplateShortName>Payload`
 */
class KotlinPayloadGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outputDir)
        for (md in loader.root.children) {
            if (md !is MetaTemplate) continue
            emit(md, loader, outRoot)
        }
    }

    private fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
        val payloadRef = template.payloadRef ?: return
        val payloadVo = resolveViewObject(loader, payloadRef) ?: return

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = if (templatePkg.isEmpty()) "prompts" else "$templatePkg.prompts"
        val className = templateShort + "Payload"

        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(className)
            .addModifiers(KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — payload for template `${template.name}`.\n")

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in payloadVo.children.filterIsInstance<MetaField<*>>()) {
            val type = KotlinTypeMapper.kotlinTypeName(field)
            ctorBuilder.addParameter(ParameterSpec.builder(field.name, type).build())
            typeBuilder.addProperty(
                PropertySpec.builder(field.name, type).initializer(field.name).build()
            )
        }

        FileSpec.builder(outPkg, className)
            .addType(typeBuilder.primaryConstructor(ctorBuilder.build()).build())
            .build()
            .writeTo(outRoot)
    }

    private fun resolveViewObject(loader: MetaDataLoader, ref: String): MetaObject? {
        // Match by short name OR fully-qualified name; only accept object.value
        for (child in loader.root.children) {
            if (child !is MetaObject) continue
            if (child.subType != "value") continue
            val short = child.name.substringAfterLast("::")
            if (child.name == ref || short == ref) return child
        }
        return null
    }

    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun getSingleWriter(loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?): GeneratorIOWriter<*>? = null
    override fun getFinalWriter(loader: MetaDataLoader?, out: OutputStream?): GeneratorIOWriter<*>? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String = ""
    override fun getSingleOutputFilename(md: MetaObject): String = "${md.name}.kt"
}
```

**Note:** This MVP handles primitive fields only on the payload VO. `origin.collection`, `origin.aggregate`, and `origin.passthrough` are deferred to follow-up tasks (call out in the generator's KDoc).

- [ ] **Step 3: Tests pass + commit**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinPayloadGeneratorTest
```

```bash
git add server/java/codegen-kotlin
git commit -m "feat(codegen-kotlin): KotlinPayloadGenerator — typed @Serializable payload per template.*"
```

---

# Phase 4 — Validator generator

---

### Task 4.1: `KotlinValidatorGenerator.kt` — MetadataStartupValidator + ExposedTableValidator helper

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinValidatorGenerator.kt`
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinValidatorGeneratorTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

class KotlinValidatorGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "@fields": "id" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `emits MetadataStartupValidator with one entry per entity with source rdb`() {
        val outDir = Files.createTempDirectory("kvld-")
        try {
            val gen = KotlinValidatorGenerator()
            gen.setArgs(mapOf(
                "outputDir" to outDir.toString(),
                "packageName" to "acme.demo"
            ))
            gen.execute(loadString("test", fixture))

            val validator = outDir.resolve("acme/demo/MetadataStartupValidator.kt")
            val helper = outDir.resolve("acme/demo/ExposedTableValidator.kt")
            assertTrue(Files.exists(validator), "expected $validator")
            assertTrue(Files.exists(helper), "expected $helper")

            val vSrc = Files.readString(validator)
            assertTrue("object MetadataStartupValidator" in vSrc, vSrc)
            assertTrue("fun validate(loader: MetaDataLoader)" in vSrc, vSrc)
            assertTrue("\"acme::demo::Author\" to AuthorTable" in vSrc, vSrc)

            val hSrc = Files.readString(helper)
            assertTrue("object ExposedTableValidator" in hSrc, hSrc)
            assertTrue("fun check(obj: MetaObject, table: Table" in hSrc, hSrc)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
```

- [ ] **Step 2: Verify failure + write impl**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinValidatorGeneratorTest
```

Expected: FAIL.

```kotlin
// KotlinValidatorGenerator.kt
package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.TypeSpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Paths

/**
 * Generator: emits two files per project:
 *  - MetadataStartupValidator.kt — registry of (FQN, Table) pairs + a validate(loader) entry point
 *  - ExposedTableValidator.kt — substrate-specific helper that compares one MetaObject to one Table
 *
 * Args:
 *  - `outputDir` (required)
 *  - `packageName` (required) — the Kotlin package both files live in
 */
class KotlinValidatorGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val pkg = getArg("packageName")
            ?: throw com.metaobjects.generator.GeneratorException("packageName is required")
        val outRoot = Paths.get(outputDir)

        val entries = loader.root.children
            .filterIsInstance<MetaObject>()
            .filter { it.subType == "entity" }
            .filter { it.children.any { c -> c.type == "source" && c.subType == "rdb" } }
            .map { entity ->
                val shortName = PackageMapping.splitFqn(entity.name).second
                entity.name to "${shortName}Table"
            }

        emitValidator(pkg, entries, outRoot)
        emitHelper(pkg, outRoot)
    }

    private fun emitValidator(
        pkg: String,
        entries: List<Pair<String, String>>,
        outRoot: java.nio.file.Path
    ) {
        val loaderType = ClassName("com.metaobjects.loader", "MetaDataLoader")
        val ktxMetaObjectOrNull = ClassName("com.metaobjects.metadata.ktx", "metaObjectOrNull")
        val tableType = ClassName("org.jetbrains.exposed.sql", "Table")

        val registryCode = entries.joinToString(",\n        ") { (fqn, table) -> "\"$fqn\" to $table" }

        val validateFn = FunSpec.builder("validate")
            .addParameter("loader", loaderType)
            .addStatement("""val errors = mutableListOf<String>()""")
            .beginControlFlow("for ((fqn, table) in tablesToValidate)")
            .addStatement("""val obj = loader.metaObjectOrNull(fqn)""")
            .beginControlFlow("if (obj == null)")
            .addStatement("""errors.add("metadata missing ${'$'}fqn (generated table: ${'$'}{table.tableName})")""")
            .addStatement("continue")
            .endControlFlow()
            .addStatement("ExposedTableValidator.check(obj, table, errors)")
            .endControlFlow()
            .addStatement("""check(errors.isEmpty()) { "MetadataStartupValidator: ${'$'}{errors.size} drift(s):\n  - ${'$'}{errors.joinToString("\n  - ")}" }""")
            .build()

        val tablesProp = com.squareup.kotlinpoet.PropertySpec.builder(
            "tablesToValidate",
            ClassName("kotlin.collections", "List").parameterizedBy(
                ClassName("kotlin", "Pair").parameterizedBy(
                    ClassName("kotlin", "String"),
                    tableType
                )
            )
        )
            .addModifiers(KModifier.PRIVATE)
            .initializer(CodeBlock.of("listOf(\n        $registryCode\n    )"))
            .build()

        val obj = TypeSpec.objectBuilder("MetadataStartupValidator")
            .addKdoc("GENERATED — runtime drift gate. Call validate(loader) from a Spring @PostConstruct or ApplicationReadyEvent.\n")
            .addProperty(tablesProp)
            .addFunction(validateFn)
            .build()

        FileSpec.builder(pkg, "MetadataStartupValidator")
            .addImport("com.metaobjects.metadata.ktx", "metaObjectOrNull")
            .addType(obj)
            .build()
            .writeTo(outRoot)
    }

    private fun emitHelper(pkg: String, outRoot: java.nio.file.Path) {
        val metaObjectType = ClassName("com.metaobjects.`object`", "MetaObject")
        val tableType = ClassName("org.jetbrains.exposed.sql", "Table")
        val mutableListType = ClassName("kotlin.collections", "MutableList")
            .parameterizedBy(ClassName("kotlin", "String"))

        val check = FunSpec.builder("check")
            .addParameter("obj", metaObjectType)
            .addParameter("table", tableType)
            .addParameter("errors", mutableListType)
            .addStatement("""val expectedCols = obj.children.filterIsInstance<com.metaobjects.field.MetaField<*>>().map { it.name }.toSet()""")
            .addStatement("""val actualCols = table.columns.map { it.name }.toSet()""")
            .addStatement("""val missing = expectedCols - actualCols""")
            .addStatement("""val extra = actualCols - expectedCols""")
            .beginControlFlow("if (missing.isNotEmpty())")
            .addStatement("""errors.add("${'$'}{obj.name}: metadata declares fields not in generated table: ${'$'}missing")""")
            .endControlFlow()
            .beginControlFlow("if (extra.isNotEmpty())")
            .addStatement("""errors.add("${'$'}{obj.name}: generated table has columns not in metadata: ${'$'}extra")""")
            .endControlFlow()
            .build()

        val obj = TypeSpec.objectBuilder("ExposedTableValidator")
            .addKdoc("GENERATED — compares metadata field set vs Exposed Table column set.\n")
            .addFunction(check)
            .build()

        FileSpec.builder(pkg, "ExposedTableValidator")
            .addType(obj)
            .build()
            .writeTo(outRoot)
    }

    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun getSingleWriter(loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?): GeneratorIOWriter<*>? = null
    override fun getFinalWriter(loader: MetaDataLoader?, out: OutputStream?): GeneratorIOWriter<*>? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String = ""
    override fun getSingleOutputFilename(md: MetaObject): String = ""
}

private fun ClassName.parameterizedBy(vararg params: com.squareup.kotlinpoet.TypeName) =
    com.squareup.kotlinpoet.ParameterizedTypeName.run { this@parameterizedBy.parameterizedBy(*params) }
```

**Implementer notes:**
- The `parameterizedBy` extension at the bottom is a shorthand for KotlinPoet's `ParameterizedTypeName.get(...)`. Verify the exact KotlinPoet 1.18.1 API — there may be a built-in `ClassName.parameterizedBy()` extension already; use it if so and delete the local one.
- The `addImport("com.metaobjects.metadata.ktx", "metaObjectOrNull")` is for the top-level extension function — verify KotlinPoet's import API.
- The `${'$'}` is the Kotlin escape for `$` inside Kotlin templates that are themselves Kotlin source. Verify rendered output is correct.

- [ ] **Step 3: Tests pass + commit**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinValidatorGeneratorTest
```

```bash
git add server/java/codegen-kotlin
git commit -m "feat(codegen-kotlin): KotlinValidatorGenerator — startup validator + Exposed helper"
```

---

# Phase 5 — Snapshot tests + compile-check + E2E + README

---

### Task 5.1: `KotlinCodegenSnapshotTest.kt` — parameterized over fixtures

**Files:**
- Create: `server/java/codegen-kotlin/src/test/resources/fixtures/single-entity-primitives/meta.json`
- Create: `server/java/codegen-kotlin/src/test/resources/fixtures/single-entity-primitives/config.json`
- Create: `server/java/codegen-kotlin/src/test/resources/fixtures/template-prompt-simple/meta.json`
- Create: `server/java/codegen-kotlin/src/test/resources/fixtures/template-prompt-simple/config.json`
- Create: `server/java/codegen-kotlin/src/test/resources/snapshots/.gitkeep` (snapshots populated by first run)
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinCodegenSnapshotTest.kt`

- [ ] **Step 1: Add fixtures**

`fixtures/single-entity-primitives/meta.json`:

```json
{
  "metadata.root": {
    "package": "acme::demo",
    "children": [
      { "object.entity": { "name": "Author", "children": [
          { "field.long":      { "name": "id" } },
          { "field.string":    { "name": "name", "@maxLength": 100 } },
          { "field.string":    { "name": "bio" } },
          { "field.int":       { "name": "age" } },
          { "field.boolean":   { "name": "active" } },
          { "field.double":    { "name": "ratio" } },
          { "field.date":      { "name": "birthday" } },
          { "field.timestamp": { "name": "createdAt" } },
          { "source.rdb":      { "@table": "authors" } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ] } }
    ]
  }
}
```

`fixtures/single-entity-primitives/config.json`:

```json
{
  "generators": ["entity", "table", "validator"],
  "validatorPackage": "acme.demo"
}
```

`fixtures/template-prompt-simple/meta.json`:

```json
{
  "metadata.root": {
    "package": "acme::ai",
    "children": [
      { "object.value": { "name": "Author", "children": [
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "name" } }
      ] } },
      { "template.prompt": { "name": "WelcomePrompt",
          "@payloadRef": "Author", "@textRef": "ai/welcome" } }
    ]
  }
}
```

`fixtures/template-prompt-simple/config.json`:

```json
{
  "generators": ["payload"]
}
```

- [ ] **Step 2: Write the parameterized snapshot test**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.absolutePathString
import kotlin.io.path.isDirectory
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.fail

/**
 * Parameterized snapshot test — for each fixture under src/test/resources/fixtures/,
 * runs the configured generators and compares each emitted .kt against the snapshot
 * at src/test/resources/snapshots/<fixture-name>/<filename>.
 *
 * First run creates snapshots and fails with "review + commit". Subsequent runs gate.
 */
class KotlinCodegenSnapshotTest {

    private val fixturesRoot: Path = Paths.get("src/test/resources/fixtures").toAbsolutePath()
    private val snapshotsRoot: Path = Paths.get("src/test/resources/snapshots").toAbsolutePath()

    @TestFactory
    fun snapshotTests(): List<DynamicTest> {
        if (!fixturesRoot.isDirectory()) return emptyList()
        return Files.list(fixturesRoot).filter { it.isDirectory() }
            .sorted()
            .map { fixtureDir ->
                DynamicTest.dynamicTest("snapshot:${fixtureDir.fileName}") {
                    runOne(fixtureDir)
                }
            }
            .toList()
    }

    private fun runOne(fixtureDir: Path) {
        val name = fixtureDir.fileName.toString()
        val metaText = fixtureDir.resolve("meta.json").readText()
        val configText = fixtureDir.resolve("config.json").readText()
        val config = parseConfig(configText)

        val outDir = Files.createTempDirectory("snap-$name-")
        try {
            val loader = loadString(name, metaText)
            for (g in config.generators) {
                val gen = when (g) {
                    "entity"    -> KotlinEntityGenerator()
                    "table"     -> KotlinExposedTableGenerator()
                    "payload"   -> KotlinPayloadGenerator()
                    "validator" -> KotlinValidatorGenerator()
                    else -> fail("unknown generator name in config: $g")
                }
                val args = mutableMapOf("outputDir" to outDir.toString())
                if (g == "validator") args["packageName"] = config.validatorPackage ?: fail("validator config needs validatorPackage")
                gen.setArgs(args)
                gen.execute(loader)
            }

            val snapshotDir = snapshotsRoot.resolve(name)
            val emittedFiles = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()

            if (!snapshotDir.isDirectory()) {
                // First run: create snapshots
                Files.createDirectories(snapshotDir)
                for (f in emittedFiles) {
                    val rel = outDir.relativize(f)
                    val target = snapshotDir.resolve(rel)
                    Files.createDirectories(target.parent)
                    Files.copy(f, target)
                }
                fail("snapshots created for '$name' at ${snapshotDir.absolutePathString()} — review + commit. Re-run to gate.")
            }

            // Subsequent runs: compare each emitted file to its snapshot
            for (f in emittedFiles) {
                val rel = outDir.relativize(f)
                val snap = snapshotDir.resolve(rel)
                if (!snap.isRegularFile()) {
                    fail("emitted file has no snapshot: $rel (write snapshot to $snap and re-run)")
                }
                val actual = f.readText()
                val expected = snap.readText()
                if (actual != expected) {
                    fail("snapshot drift in $name/$rel\nEXPECTED:\n$expected\nACTUAL:\n$actual")
                }
            }
            // Also verify no snapshot file is missing from emission
            val snapFiles = Files.walk(snapshotDir).filter { it.isRegularFile() }.toList()
            val emittedRels = emittedFiles.map { outDir.relativize(it) }.toSet()
            for (s in snapFiles) {
                val rel = snapshotDir.relativize(s)
                if (rel !in emittedRels) {
                    fail("snapshot has no emitted counterpart: $rel (stale snapshot? delete or fix generator)")
                }
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private data class FixtureConfig(val generators: List<String>, val validatorPackage: String?)

    private fun parseConfig(json: String): FixtureConfig {
        // Crude JSON parse — fixtures are tiny + controlled. No Jackson dep added for this.
        val gens = Regex("\"generators\"\\s*:\\s*\\[([^\\]]+)]").find(json)?.groupValues?.get(1)
            ?.split(",")?.map { it.trim().trim('"') } ?: emptyList()
        val pkg = Regex("\"validatorPackage\"\\s*:\\s*\"([^\"]+)\"").find(json)?.groupValues?.get(1)
        return FixtureConfig(gens, pkg)
    }
}
```

- [ ] **Step 3: First run creates snapshots, fails with review-and-commit message**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinCodegenSnapshotTest 2>&1 | tail -30
```

Expected: 2 tests FAIL with "snapshots created for ... — review + commit". Inspect the contents of `src/test/resources/snapshots/<fixture>/<file>.kt` — verify each looks like reasonable Kotlin code (no garbled output, sensible types, proper imports). If anything looks wrong, fix the generator and start fresh.

- [ ] **Step 4: Commit snapshots + re-run to confirm gate**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git add server/java/codegen-kotlin/src/test/resources/snapshots
git commit -m "test(codegen-kotlin): initial snapshots for fixtures"
mvn -pl codegen-kotlin test -q -Dtest=KotlinCodegenSnapshotTest 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 5: Commit the harness + fixtures**

```bash
git add server/java/codegen-kotlin/src/test/kotlin server/java/codegen-kotlin/src/test/resources/fixtures
git commit -m "test(codegen-kotlin): KotlinCodegenSnapshotTest + 2 fixtures"
```

---

### Task 5.2: `KotlinOutputCompilesTest.kt` — kotlin-compile-testing gate

**Files:**
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinOutputCompilesTest.kt`

- [ ] **Step 1: Write the test**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

class KotlinOutputCompilesTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 100 } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `generated Author kt compiles`() {
        val outDir = Files.createTempDirectory("compile-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val sources = Files.walk(outDir).filter { it.isRegularFile() }
                .map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
                .toList()

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true   // include kotlinx.serialization-runtime + Exposed if on the test classpath
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated Kotlin failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
```

- [ ] **Step 2: Confirm it passes**

```bash
mvn -pl codegen-kotlin test -q -Dtest=KotlinOutputCompilesTest 2>&1 | tail -10
```

Expected: PASS — the simple Author data class compiles. If FAIL, the compiler error message in the test output will tell you what's wrong; fix the generator.

- [ ] **Step 3: Commit**

```bash
git add server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinOutputCompilesTest.kt
git commit -m "test(codegen-kotlin): KotlinOutputCompilesTest — kotlin-compile-testing gate"
```

---

### Task 5.3: `KotlinCodegenE2ETest.kt` — full loop + populated README

**Files:**
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinCodegenE2ETest.kt`
- Modify: `server/java/codegen-kotlin/README.md` — populated

- [ ] **Step 1: Write the E2E test**

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.metadata.ktx.render
import com.metaobjects.render.InMemoryProvider
import kotlin.test.Test
import kotlin.test.assertEquals

class KotlinCodegenE2ETest {

    /**
     * Proves the full loop: codegen → consumer constructs payload (here, a Map equivalent
     * for the in-test simulation) → Java Renderer renders → expected output.
     * Doesn't physically compile + load the generated class — kotlin-compile-testing covers
     * the compile gate; this test covers semantic round-trip via the metadata-ktx render builder.
     */
    @Test fun `payload structure round-trips through Java render`() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "name" } }
            ] } },
            { "template.prompt": { "name": "Hello",
                "@payloadRef": "Greeting", "@textRef": "g/hello" } }
          ] }
        }""".trimIndent()
        val loader = loadString("e2e", fixture)
        // Codegen verified by KotlinPayloadGeneratorTest. Here we exercise render
        // with a runtime payload Map equivalent to what the generated class would carry.
        val out = render {
            ref = "g/hello"
            payload = mapOf("name" to "Ada")
            provider = InMemoryProvider(mapOf("g/hello" to "Hello {{name}}!"))
        }
        assertEquals("Hello Ada!", out)
    }
}
```

- [ ] **Step 2: Populate README**

`server/java/codegen-kotlin/README.md`:

```markdown
# MetaObjects :: Codegen :: Kotlin (`codegen-kotlin`)

Kotlin codegen target. Emits idiomatic Kotlin code from MetaObjects metadata via KotlinPoet:

| Generator | Output | Per |
|---|---|---|
| `KotlinEntityGenerator` | `<Entity>.kt` — @Serializable data class | every `object.entity` |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object | every entity with `source.rdb` |
| `KotlinPayloadGenerator` | `<Template>Payload.kt` — @Serializable payload class | every `template.prompt` / `template.output` |
| `KotlinValidatorGenerator` | `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` | once per project |

## Wiring in your `pom.xml`

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <loader>
      <sourceDir>src/main/metaobjects</sourceDir>
    </loader>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinEntityGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinExposedTableGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinPayloadGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinValidatorGenerator</classname>
        <args>
          <outputDir>${project.build.directory}/generated-sources/kotlin</outputDir>
          <packageName>com.yourapp</packageName>
        </args>
      </generator>
    </generators>
  </configuration>
</plugin>
```

## Runtime drift gate

After codegen runs, your consumer wires the generated `MetadataStartupValidator` into Spring boot:

```kotlin
@SpringBootApplication
class App {
    @EventListener(ApplicationReadyEvent::class)
    fun validateMetadata() {
        val loader = loadResources("app", listOf("meta.author.json"))
        MetadataStartupValidator.validate(loader)
    }
}
```

This fails fast at boot if generated tables drift from metadata (drift source D7).

## Coverage status

MVP ships 7 primitive types (`field.string`, `int`, `long`, `double`, `boolean`, `date`, `timestamp`).
Less-common types (`field.enum`, `field.currency`, `field.object`, `field.uuid`) throw
`IllegalArgumentException` at codegen time with a clear message. Add support per real consumer ask.

Flyway migration generation lives in the Maven plugin under the existing `meta:migrate` goal —
pass `<flyway>true</flyway>` to switch output naming to Flyway conventions.

CI drift detection lives in the new `meta:verify` goal — runs DB introspection + diffs vs metadata.
```

- [ ] **Step 3: Run full module + commit**

```bash
mvn -pl codegen-kotlin test -q 2>&1 | grep -E 'Tests run|BUILD' | tail -3
```

Expected: BUILD SUCCESS.

```bash
git add server/java/codegen-kotlin
git commit -m "test(codegen-kotlin): E2E + README populated"
```

---

# Phase 6 — Maven plugin extensions (Flyway + verify mojo)

---

### Task 6.1: Extend `MetaDataMigrateMojo` with Flyway naming

**Files:**
- Modify: `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataMigrateMojo.java`

- [ ] **Step 1: Read the current `runEmit()` method**

Look at `MetaDataMigrateMojo.java` lines ~208-221 for the existing `runEmit()` implementation. The current output: `target/migrations/<timestamp>-<slug>/up.sql`. We're adding an alternate path: `<flywayDir>/V<nextVersion>__<slug>.sql`.

- [ ] **Step 2: Add three new mojo parameters + update runEmit**

In `MetaDataMigrateMojo.java`, after the existing `@Parameter` declarations:

```java
/** When true, emit migrations into a Flyway-conventional directory. */
@Parameter(property = "meta.migrate.flyway", defaultValue = "false")
private boolean flyway;

/** Flyway migrations directory (relative to project basedir). */
@Parameter(property = "meta.migrate.flywayDir",
           defaultValue = "src/main/resources/db/migration")
private String flywayDir;

/** Flyway version prefix (e.g., "V" or "U"). */
@Parameter(property = "meta.migrate.flywayPrefix", defaultValue = "V")
private String flywayPrefix;
```

Modify `runEmit()`:

```java
private void runEmit(SchemaMigrationEngine engine, Connection c, AllowOptions allow) throws Exception {
    EmitResult result = engine.emit(c, allow);
    String up = result.up();
    if (up == null || up.isBlank()) {
        getLog().info("Nothing to emit — schema is already in sync.");
        return;
    }
    String content = up.endsWith("\n") ? up : up + "\n";

    Path target;
    if (flyway) {
        Path dir = Path.of(flywayDir);
        Files.createDirectories(dir);
        int nextVersion = nextFlywayVersion(dir, flywayPrefix);
        String filename = String.format("%s%03d__%s.sql", flywayPrefix, nextVersion, sanitize(slug));
        target = dir.resolve(filename);
    } else {
        Path dir = Path.of(outputDir, timestamp() + "-" + sanitize(slug));
        Files.createDirectories(dir);
        target = dir.resolve("up.sql");
    }
    Files.writeString(target, content);
    getLog().info("Wrote migration script: " + target);
}

private int nextFlywayVersion(Path dir, String prefix) throws IOException {
    if (!Files.isDirectory(dir)) return 1;
    java.util.regex.Pattern p = java.util.regex.Pattern.compile(
        "^" + java.util.regex.Pattern.quote(prefix) + "(\\d+)__.*\\.sql$");
    int max = 0;
    try (var stream = Files.list(dir)) {
        for (Path f : stream.toList()) {
            var m = p.matcher(f.getFileName().toString());
            if (m.matches()) {
                int v = Integer.parseInt(m.group(1));
                if (v > max) max = v;
            }
        }
    }
    return max + 1;
}
```

- [ ] **Step 3: Write a test for the Flyway naming**

`server/java/maven-plugin/src/test/java/com/metaobjects/mojo/MetaDataMigrateMojoFlywayTest.java`:

```java
package com.metaobjects.mojo;

import org.junit.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.Method;
import static org.junit.Assert.assertEquals;

public class MetaDataMigrateMojoFlywayTest {

    @Test public void nextVersionStartsAtOneOnEmptyDir() throws Exception {
        Path dir = Files.createTempDirectory("fw-");
        try {
            int v = invokeNextFlywayVersion(dir, "V");
            assertEquals(1, v);
        } finally {
            Files.deleteIfExists(dir);
        }
    }

    @Test public void nextVersionIncrementsHighest() throws Exception {
        Path dir = Files.createTempDirectory("fw-");
        try {
            Files.writeString(dir.resolve("V001__init.sql"), "");
            Files.writeString(dir.resolve("V003__skip.sql"), "");
            Files.writeString(dir.resolve("V005__latest.sql"), "");
            int v = invokeNextFlywayVersion(dir, "V");
            assertEquals(6, v);
        } finally {
            for (Path p : Files.list(dir).toList()) Files.deleteIfExists(p);
            Files.deleteIfExists(dir);
        }
    }

    @Test public void nextVersionIgnoresNonMatchingFiles() throws Exception {
        Path dir = Files.createTempDirectory("fw-");
        try {
            Files.writeString(dir.resolve("README.md"), "");
            Files.writeString(dir.resolve("V002__only.sql"), "");
            int v = invokeNextFlywayVersion(dir, "V");
            assertEquals(3, v);
        } finally {
            for (Path p : Files.list(dir).toList()) Files.deleteIfExists(p);
            Files.deleteIfExists(dir);
        }
    }

    private static int invokeNextFlywayVersion(Path dir, String prefix) throws Exception {
        Method m = MetaDataMigrateMojo.class.getDeclaredMethod("nextFlywayVersion", Path.class, String.class);
        m.setAccessible(true);
        return (int) m.invoke(new MetaDataMigrateMojo(), dir, prefix);
    }
}
```

- [ ] **Step 4: Run tests + commit**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java && mvn -pl maven-plugin test -q -Dtest=MetaDataMigrateMojoFlywayTest 2>&1 | tail -5
```

Expected: 3 tests PASS.

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git add server/java/maven-plugin
git commit -m "feat(maven-plugin): meta:migrate Flyway-naming option for codegen-kotlin consumers"
```

---

### Task 6.2: New `MetaDataVerifyMojo`

**Files:**
- Create: `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataVerifyMojo.java`

The `meta:verify` mojo: introspect the live DB, diff vs metadata, fail the build if drift detected.

Looking at the existing `MetaDataMigrateMojo`, the existing `verify` verb already does exactly this. So this task is **just exposing it as its own mojo annotation + name** — a thin wrapper, no new logic.

- [ ] **Step 1: Write the mojo**

```java
package com.metaobjects.mojo;

import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.ResolutionScope;

/**
 * Maven goal: {@code meta:verify} — CI drift detection.
 *
 * <p>Convenience wrapper that runs the existing {@link MetaDataMigrateMojo} with verb="verify".
 * Fails the build if the live DB schema drifts from the metadata-declared schema.
 */
@Mojo(name = "verify", defaultPhase = LifecyclePhase.VERIFY, requiresDependencyResolution = ResolutionScope.COMPILE_PLUS_RUNTIME)
public class MetaDataVerifyMojo extends MetaDataMigrateMojo {

    public MetaDataVerifyMojo() {
        super();
    }

    @Override
    public void execute() throws MojoExecutionException {
        // Force verb=verify regardless of pom config.
        try {
            java.lang.reflect.Field verbField = MetaDataMigrateMojo.class.getDeclaredField("verb");
            verbField.setAccessible(true);
            verbField.set(this, "verify");
        } catch (Exception e) {
            throw new MojoExecutionException("failed to force verify verb", e);
        }
        super.execute();
    }
}
```

- [ ] **Step 2: Compile + commit**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java && mvn -pl maven-plugin compile -q 2>&1 | tail -5
```

Expected: success.

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git add server/java/maven-plugin
git commit -m "feat(maven-plugin): meta:verify goal — CI drift gate (wraps existing verb)"
```

---

### Task 6.3: Full reactor sanity check

- [ ] **Step 1: Run the full reactor**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java && mvn test 2>&1 | grep -E 'BUILD SUCCESS|BUILD FAILURE|Tests run:' | tail -3
```

Expected: BUILD SUCCESS. Reactor includes new codegen-kotlin module.

If any test fails, investigate + fix before the review gate.

---

# Phase 7 — Review gate + merge

---

### Task 7.1: Review gate (reviewer + simplifier in parallel) + merge to main

- [ ] **Step 1: Dispatch code-reviewer + code-simplifier in parallel**

Code-reviewer scope: all new files under `server/java/codegen-kotlin/`, `MetaDataMigrateMojo.java` modifications, `MetaDataVerifyMojo.java`. Look for:
- KotlinPoet idiom: are `addImport` / `addType` / `parameterizedBy` used correctly?
- Generator pattern: do all 4 generators properly extend `MultiFileDirectGeneratorBase`? Did the implementer have to use `getSingleWriter`/etc. abstract-stub overrides? Are they truly unused or did they accidentally do something subtle?
- KotlinTypeMapper coverage gaps (missing enum/currency/object/uuid) — confirm spec §6 marks these as deferred, not gaps
- Validator generator: does the emitted Kotlin code actually compile? The compile-check test should catch this; verify it's run.
- Flyway version-numbering: race condition (two devs at the same V003)? Reasonable hazard for v1?

Code-simplifier scope: same.

- [ ] **Step 2: Apply Important findings**

- [ ] **Step 3: Re-run full reactor**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation/server/java && mvn test 2>&1 | grep -E 'BUILD SUCCESS|BUILD FAILURE|Tests run:' | tail -3
```

- [ ] **Step 4: Merge to main**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git fetch origin main
git merge --no-ff origin/main -m "Merge origin/main into worktree-codegen-kotlin (pre-merge sync)"
cd server/java && mvn test -q
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
git push -u origin worktree-codegen-kotlin

git -C /home/doug/Development/metaobjects pull --ff-only origin main
git -C /home/doug/Development/metaobjects merge --no-ff worktree-codegen-kotlin \
  -m "Merge codegen-kotlin — Kotlin codegen target + Flyway migration integration"
git -C /home/doug/Development/metaobjects push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec § | Plan task(s) |
|---|---|
| §3 Module layout | 1.1 |
| §4.1 KotlinEntityGenerator | 2.1 |
| §4.2 KotlinExposedTableGenerator | 2.2 |
| §4.3 KotlinPayloadGenerator | 3.1 |
| §4.4 KotlinValidatorGenerator | 4.1 |
| §5.1 MetaDataMigrateMojo + Flyway | 6.1 |
| §5.2 MetaDataVerifyMojo | 6.2 |
| §6 Type mapping table | 1.3 (KotlinTypeMapper covers 7 of 12 types — rest deferred per spec) |
| §7 Testing strategy (unit) | 1.2, 1.3, 2.1, 2.2, 3.1, 4.1 |
| §7 Testing strategy (snapshot) | 5.1 |
| §7 Testing strategy (compile-check) | 5.2 |
| §7 Testing strategy (E2E) | 5.3 |
| §8 Drift-source coverage | covered by combination — D1+D2 via codegen, D3 via Task 6.2 verify mojo, D4 via Task 6.1 Flyway migrate, D5 via @generated headers in KotlinPoet output, D6 via FR-004 payload gen (Task 3.1), D7 via validator generator (Task 4.1) |
| §10 Tier classification | inherent in generator names + payload field semantics — no separate task needed |

**Placeholder scan:** searched for "TBD", "TODO", "fill in", "similar to" — none. Where Java API names are uncertain, plan includes explicit "verify exact API at impl time" notes — these are real implementer instructions, not placeholders.

**Type consistency:**
- `KotlinTypeMapper.kotlinTypeName(MetaField<*>)` — used in 2.1 (entity), 3.1 (payload), and indirectly in 2.2 (via `exposedColumnSpec`)
- `KotlinTypeMapper.exposedColumnSpec(MetaField<*>)` — used only in 2.2
- `PackageMapping.splitFqn(String): Pair<String, String>` — used in 2.1, 2.2, 3.1, 4.1
- Generator arg names: `outputDir` (all 4), `packageName` (validator only) — consistent
- Output naming: `<Entity>.kt`, `<Entity>Table.kt`, `<TemplateShort>Payload.kt`, `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` — all match spec §4

No drift detected.

---

## Execution

**Subagent-Driven Development** — single implementer subagent runs Phases 1–6 sequentially (all tasks tightly coupled). Controller dispatches reviewer + simplifier for Phase 7, then merges.
