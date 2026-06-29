package com.metaobjects.generator.kotlin

import com.metaobjects.attr.IntAttribute
import com.metaobjects.attr.StringAttribute
import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DecimalField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.FloatField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MapField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
import com.metaobjects.field.UuidField
import com.metaobjects.metadata.ktx.loadString
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.FLOAT
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.STRING
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KotlinTypeMapperTest {

    companion object {
        // Force full SPI/registry initialization before any direct MetaField instantiation,
        // which would otherwise short-circuit the FieldTypesMetaDataProvider registration chain.
        init { TestRegistryBootstrap.ensureInitialized() }
    }


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

    @Test fun `float field maps to Float`() {
        val f = FloatField("weight")
        assertEquals(FLOAT, KotlinTypeMapper.kotlinTypeName(f))
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

    @Test fun `time field maps to java time LocalTime`() {
        val f = TimeField("startTime")
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.time", tn.packageName)
        assertEquals("LocalTime", tn.simpleName)
    }

    @Test fun `timestamp field defaults to java time LocalDateTime`() {
        // Default for field.timestamp is zone-less LocalDateTime (Postgres `timestamp
        // without time zone`) — the cross-port wire value is zone-less (no `Z`), which an
        // Instant cannot carry. Opt in to Instant via @dbColumnType=timestamp_with_tz.
        val f = TimestampField("createdAt")
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.time", tn.packageName)
        assertEquals("LocalDateTime", tn.simpleName)
    }

    @Test fun `timestamp field with dbColumnType=timestamp_with_tz maps to java time Instant`() {
        val f = TimestampField("createdAt")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "timestamp_with_tz"))
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

    @Test fun `string field with dbColumnType=uuid_array maps to List of UUID + Exposed array column`() {
        val f = StringField("memberIds")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "uuid_array"))
        assertEquals("kotlin.collections.List<java.util.UUID>", KotlinTypeMapper.kotlinTypeName(f).toString())
        assertEquals("array<java.util.UUID>(\"member_ids\", org.jetbrains.exposed.sql.UUIDColumnType())", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `string field with dbColumnType=text_array maps to List of String + Exposed array column`() {
        val f = StringField("tags")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "text_array"))
        assertEquals("kotlin.collections.List<kotlin.String>", KotlinTypeMapper.kotlinTypeName(f).toString())
        assertEquals("array<String>(\"tags\", org.jetbrains.exposed.sql.TextColumnType())", KotlinTypeMapper.exposedColumnSpec(f))
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

    @Test fun `float field maps to float exposed column`() {
        val f = FloatField("weight")
        assertEquals("float(\"weight\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `date field maps to date exposed column`() {
        val f = DateField("birthday")
        assertEquals("date(\"birthday\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `time field maps to time exposed column`() {
        val f = TimeField("startTime")
        // Column name snake_case-d for Postgres convention (mirrors date(...)).
        assertEquals("time(\"start_time\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `time field import is javatime time`() {
        // `time(...)` is a javatime extension function (like `date(...)`); it needs an
        // explicit import — the bug-prone part of the arm.
        val f = TimeField("startTime")
        assertEquals(
            "org.jetbrains.exposed.sql.javatime.time",
            KotlinTypeMapper.exposedColumnImport(f),
        )
    }

    @Test fun `timestamp field defaults to datetime exposed column with snake_case column name`() {
        // Default for field.timestamp is `datetime(...)` (Postgres `timestamp without time
        // zone`, java.time.LocalDateTime — the zone-less wall-clock wire shape). Column name
        // is snake_case-d.
        val f = TimestampField("createdAt")
        assertEquals("datetime(\"created_at\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `timestamp field with dbColumnType=timestamp_with_tz emits instantWithTimeZone`() {
        // Opt-in: `@dbColumnType=timestamp_with_tz` selects a `Column<Instant>` column whose
        // Postgres DDL is `timestamp with time zone`. The emitted column function is the
        // file-local `instantWithTimeZone(...)` extension (a custom ColumnType<Instant>), NOT
        // Exposed's native `timestampWithTimeZone(...)` — that one is Column<OffsetDateTime>
        // and would MISMATCH the `Instant` data-class property, forcing Instant↔OffsetDateTime
        // coercion at every callsite.
        val f = TimestampField("createdAt")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "timestamp_with_tz"))
        assertEquals("instantWithTimeZone(\"created_at\")", KotlinTypeMapper.exposedColumnSpec(f))
        // The helper is emitted into the table's own file by KotlinExposedTableGenerator, so the
        // column function needs NO external import (the javatime import is gone).
        assertEquals(null, KotlinTypeMapper.exposedColumnImport(f))
        // The data-class property type stays Instant (unchanged — the wire/DTO contract is correct).
        assertEquals(ClassName("java.time", "Instant"), KotlinTypeMapper.kotlinTypeName(f))
        // And the table generator is told this field needs the file-local support helper.
        assertEquals(true, KotlinTypeMapper.usesInstantWithTimeZone(f))
    }

    @Test fun `timestamp field default import is javatime datetime`() {
        val f = TimestampField("createdAt")
        assertEquals(
            "org.jetbrains.exposed.sql.javatime.datetime",
            KotlinTypeMapper.exposedColumnImport(f),
        )
    }

    @Test fun `string field with dbColumnType=uuid emits uuid column instead of varchar`() {
        // `@dbColumnType=uuid` on a `field.string` selects the native Postgres uuid column
        // type. Kotlin property type stays `String` (no change to the data class shape;
        // Exposed coerces String ↔ uuid at the SQL boundary).
        val f = StringField("userId")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "uuid"))
        assertEquals("uuid(\"user_id\")", KotlinTypeMapper.exposedColumnSpec(f))
        // Kotlin type unchanged — still String.
        assertEquals(STRING, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `string field with dbColumnType=jsonb emits real jsonb column not text`() {
        // R6 Plan 2b: `@dbColumnType=jsonb` on a `field.string` selects a native Postgres
        // JSONB column (matching the other 4 ports). NOT the old `text(...)` — a TEXT column
        // never round-trips to JSONB in the introspection corpus.
        //
        // Issue #98: the column codec now PARSES the JSONB text to a kotlinx `JsonElement`
        // (decode `Json.parseToJsonElement`, encode `it.toString()`) instead of the old
        // identity passthrough `{ it }, { it }`, so the entity data-class property is a parsed
        // JSON value, not a raw-JSON `String`. The decode anchors the Exposed column's generic
        // to `JsonElement`. It is STILL a real `jsonb(...)` column — only the codec/type changes.
        val f = StringField("rubricWeights")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "jsonb"))
        assertEquals(
            "jsonb(\"rubric_weights\", { it.toString() }, { Json.parseToJsonElement(it) })",
            KotlinTypeMapper.exposedColumnSpec(f),
        )
        assertEquals(ClassName("kotlinx.serialization.json", "JsonElement"), KotlinTypeMapper.kotlinTypeName(f))
        // The column needs the exposed-json `jsonb` extension import.
        assertEquals("org.jetbrains.exposed.sql.json.jsonb", KotlinTypeMapper.exposedColumnImport(f))
    }

    @Test fun `string field with dbColumnType=jsonb exposes a parsed JSON value at every layer`() {
        // Issue #98 (cross-port jsonb open-bag REST contract). A `field.string @dbColumnType=jsonb`
        // is the sanctioned "open JSON bag": the physical column is JSONB but the LOGICAL subtype
        // stays `string`. Per the maintainer decision the bag is a PARSED JSON value (kotlinx
        // `JsonElement`) UNIFORMLY at every layer — payload, entity data class (the reused CRUD DTO),
        // and the Exposed column codec — so a client sends/receives a real JSON object, never a
        // double-encoded string. Matches TS `z.unknown()` (#97), Python `Any` (#99), C# `JsonDocument`.
        val f = StringField("rubricWeights")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "jsonb"))

        val jsonElement = ClassName("kotlinx.serialization.json", "JsonElement")
        // REST payload → parsed JSON value.
        assertEquals(jsonElement, KotlinTypeMapper.payloadTypeName(f))
        // Entity data class / entity-CRUD DTO → parsed JSON value (now uniform with payload).
        assertEquals(jsonElement, KotlinTypeMapper.kotlinTypeName(f))
        // The Exposed column stays a real jsonb column but parses to JsonElement.
        assertEquals(
            "jsonb(\"rubric_weights\", { it.toString() }, { Json.parseToJsonElement(it) })",
            KotlinTypeMapper.exposedColumnSpec(f),
        )
    }

    @Test fun `plain string field payload stays String`() {
        // payloadTypeName only diverges from kotlinTypeName for the jsonb open-bag; a plain
        // `field.string` payload property is still `String` (no double-encoding concern).
        val f = StringField("name")
        assertEquals(STRING, KotlinTypeMapper.payloadTypeName(f))
    }

    @Test fun `string field with dbColumnType=jsonb is case-insensitive`() {
        // `@dbColumnType` lookup case-folds (see `KotlinTypeMapper.dbColumnType`); both
        // `"JSONB"` and `"jsonb"` route to the JSONB branch.
        val f = StringField("featureFlags")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "JSONB"))
        assertEquals(
            "jsonb(\"feature_flags\", { it.toString() }, { Json.parseToJsonElement(it) })",
            KotlinTypeMapper.exposedColumnSpec(f),
        )
    }

    @Test fun `string field with dbColumnType=jsonb ignores maxLength`() {
        // A short `@maxLength` would normally select varchar; the JSONB override wins
        // regardless so a YAML with both attributes still gets the JSONB column.
        val f = StringField("blob")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "jsonb"))
        f.addMetaAttr(IntAttribute.create("maxLength", 64))
        assertEquals(
            "jsonb(\"blob\", { it.toString() }, { Json.parseToJsonElement(it) })",
            KotlinTypeMapper.exposedColumnSpec(f),
        )
    }

    // === Currency / Enum / UUID coverage ===

    @Test fun `currency field maps to Long and long exposed column with snake_case name`() {
        val f = CurrencyField("priceCents")
        // Wire/JVM type: Long (integer minor units invariant).
        assertEquals(LONG, KotlinTypeMapper.kotlinTypeName(f))
        // Exposed column reuses long() — same physical storage as LongField.
        // Column name snake_case-d for Postgres convention.
        assertEquals("long(\"price_cents\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `enum field maps to String and varchar(64) exposed column`() {
        val f = EnumField("status")
        // v1 enum representation: String + VARCHAR; full enum-class emission deferred.
        assertEquals(STRING, KotlinTypeMapper.kotlinTypeName(f))
        assertEquals("varchar(\"status\", 64)", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun enumTypeNameComputesClassName() {
        // Load a small fixture so we have a real MetaObject Player with field.enum status.
        // The naming rule under test is <EntityShortName><FieldPascalCase> in the entity's package.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Player", "children": [
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "status",
                    "@values": ["ACTIVE", "INACTIVE", "BANNED"] } }
            ] } }
          ] }
        }""".trimIndent()
        val loader = loadString("enum-name", fx)
        val entity = loader.metaObjects.first { it.name == "acme::demo::Player" }
        val field = entity.metaFields.first { it.name == "status" } as EnumField

        val name = KotlinTypeMapper.enumTypeName(field, entity)
        assertEquals("acme.demo", name?.packageName)
        assertEquals("PlayerStatus", name?.simpleName)

        // Non-enum fields → null (caller falls through to kotlinTypeName).
        val idField = entity.metaFields.first { it.name == "id" }
        assertNull(KotlinTypeMapper.enumTypeName(idField, entity))
    }

    // === Long-text dispatch (varchar vs text) ===

    @Test fun `string with kind text maps to text column`() {
        val f = StringField("body")
        f.addMetaAttr(StringAttribute.create("kind", "text"))
        assertEquals("text(\"body\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `string with maxLength over threshold maps to text column`() {
        val f = StringField("description")
        f.addMetaAttr(IntAttribute.create(StringField.ATTR_MAX_LENGTH, 10000))
        assertEquals("text(\"description\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `string with no kind and small maxLength maps to varchar`() {
        val f = StringField("name")
        f.addMetaAttr(IntAttribute.create(StringField.ATTR_MAX_LENGTH, 100))
        val spec = KotlinTypeMapper.exposedColumnSpec(f)
        assertTrue(spec.contains("varchar") && spec.contains("100"), "got: $spec")
    }

    // === Decimal coverage (SP-A) ===

    @Test fun `decimal field maps to java math BigDecimal`() {
        // field.decimal → high-precision java.math.BigDecimal (NUMERIC/DECIMAL).
        val f = DecimalField.create("preciseKg", 9, 4)
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.math", tn.packageName)
        assertEquals("BigDecimal", tn.simpleName)
    }

    @Test fun `decimal field maps to decimal exposed column reading precision and scale`() {
        // field.decimal → Exposed `decimal(name, precision, scale)`. Declared
        // @precision/@scale flow through (the corpus declares 9,4). Column name
        // snake_case-d for Postgres convention (mirrors the other arms).
        val f = DecimalField.create("preciseKg", 9, 4)
        assertEquals("decimal(\"precise_kg\", 9, 4)", KotlinTypeMapper.exposedColumnSpec(f))
        // `decimal(...)` is a member of Table — no extra import line.
        assertNull(KotlinTypeMapper.exposedColumnImport(f))
    }

    @Test fun `uuid field maps to java util UUID and uuid exposed column`() {
        // R6 Plan 2a: `field.uuid` is now a real UuidField JVM class — the mapper matches it
        // by instanceof (the latent subtype-string arm is promoted to a live typed arm).
        val f = UuidField("externalId")
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.util", tn.packageName)
        assertEquals("UUID", tn.simpleName)
        // Column name snake_case-d for Postgres convention.
        assertEquals("uuid(\"external_id\")", KotlinTypeMapper.exposedColumnSpec(f))
        // `uuid(...)` is a Table member — no extra import line needed.
        assertNull(KotlinTypeMapper.exposedColumnImport(f))
    }

    // === field.map coverage =================================================

    @Test fun `map field with valueType=string maps to Map of String to String`() {
        // field.map @valueType=string → Kotlin `Map<String, String>` property.
        val f = MapField("labels")
        f.addMetaAttr(StringAttribute.create(MapField.ATTR_VALUE_TYPE, "string"))
        assertEquals(
            com.squareup.kotlinpoet.MAP.parameterizedBy(STRING, STRING),
            KotlinTypeMapper.kotlinTypeName(f),
        )
    }

    @Test fun `map field with valueType=long maps to Map of String to Long`() {
        val f = MapField("counts")
        f.addMetaAttr(StringAttribute.create(MapField.ATTR_VALUE_TYPE, "long"))
        assertEquals(
            com.squareup.kotlinpoet.MAP.parameterizedBy(STRING, LONG),
            KotlinTypeMapper.kotlinTypeName(f),
        )
    }

    @Test fun `map field emits a single jsonb exposed column`() {
        // field.map → ONE jsonb column (same emission as a jsonb-stored field.object).
        // Never flattened, never a native array.
        val f = MapField("labels")
        f.addMetaAttr(StringAttribute.create(MapField.ATTR_VALUE_TYPE, "string"))
        assertEquals(
            "jsonb(\"labels\", { Json.encodeToString(it) }, { Json.decodeFromString(it) })",
            KotlinTypeMapper.exposedColumnSpec(f),
        )
        // The jsonb column needs the exposed-json import.
        assertEquals("org.jetbrains.exposed.sql.json.jsonb", KotlinTypeMapper.exposedColumnImport(f))
    }

    // === else-guard: an unmapped field subtype must fail loud, not silently regress ===
    //
    // SP-H Unit 8. The mapper's `when` arms each map a known field subtype; the trailing
    // `else` throws. A future reachable-but-unmapped subtype (the next byte/short-style hole)
    // must surface as a CLEAR, actionable IllegalArgumentException at codegen time — never a
    // silent fall-through or an opaque runtime crash downstream. `field.object` (ObjectField)
    // is a real, reachable subtype with no kotlinTypeName / exposedColumnSpec arm, so it
    // exercises the guard against a genuinely-unmapped type (not a synthetic stub).

    @Test fun `kotlinTypeName throws a clear error for an unmapped field subtype`() {
        val f = ObjectField("settings")
        val ex = assertFailsWith<IllegalArgumentException> {
            KotlinTypeMapper.kotlinTypeName(f)
        }
        val msg = ex.message ?: ""
        // Actionable: names the failed mapping, the offending Kotlin class, AND the field name.
        assertTrue(msg.contains("Kotlin type mapping"), "message should name the mapping: $msg")
        assertTrue(msg.contains("ObjectField"), "message should name the unmapped subtype class: $msg")
        assertTrue(msg.contains("settings"), "message should name the offending field: $msg")
    }

    @Test fun `exposedColumnSpec throws a clear error for an unmapped field subtype`() {
        val f = ObjectField("settings")
        val ex = assertFailsWith<IllegalArgumentException> {
            KotlinTypeMapper.exposedColumnSpec(f)
        }
        val msg = ex.message ?: ""
        assertTrue(msg.contains("Exposed column mapping"), "message should name the mapping: $msg")
        assertTrue(msg.contains("ObjectField"), "message should name the unmapped subtype class: $msg")
        assertTrue(msg.contains("settings"), "message should name the offending field: $msg")
    }
}
