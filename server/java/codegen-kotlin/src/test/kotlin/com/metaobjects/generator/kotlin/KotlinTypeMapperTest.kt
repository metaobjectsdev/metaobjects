package com.metaobjects.generator.kotlin

import com.metaobjects.DataTypes
import com.metaobjects.attr.IntAttribute
import com.metaobjects.attr.StringAttribute
import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.PrimitiveField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.metaobjects.metadata.ktx.loadString
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import kotlin.test.Test
import kotlin.test.assertEquals
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

    @Test fun `timestamp field defaults to plain timestamp exposed column with snake_case column name`() {
        // Default for field.timestamp is plain `timestamp(...)` (Postgres `timestamp
        // without time zone` — the more common shape). Column name is snake_case-d.
        val f = TimestampField("createdAt")
        assertEquals("timestamp(\"created_at\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `timestamp field with dbColumnType=timestamp_with_tz emits timestampWithTimeZone`() {
        // Opt-in: `@dbColumnType=timestamp_with_tz` selects Postgres `timestamp with time zone`.
        val f = TimestampField("createdAt")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "timestamp_with_tz"))
        assertEquals("timestampWithTimeZone(\"created_at\")", KotlinTypeMapper.exposedColumnSpec(f))
        // And the import switches accordingly.
        assertEquals(
            "org.jetbrains.exposed.sql.javatime.timestampWithTimeZone",
            KotlinTypeMapper.exposedColumnImport(f),
        )
    }

    @Test fun `timestamp field default import is plain javatime timestamp`() {
        val f = TimestampField("createdAt")
        assertEquals(
            "org.jetbrains.exposed.sql.javatime.timestamp",
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

    @Test fun `string field with dbColumnType=jsonb emits text column not capped varchar`() {
        // `@dbColumnType=jsonb` on a `field.string` opts the column to Postgres JSONB on
        // the DB side. The Exposed column is `text(...)` (unbounded) rather than the
        // default `varchar(name, 255)` — JSON payloads routinely exceed 255 chars and
        // Postgres accepts text I/O against a JSONB column. Kotlin property stays String
        // (raw JSON text); the application is responsible for validity.
        val f = StringField("rubricWeights")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "jsonb"))
        assertEquals("text(\"rubric_weights\")", KotlinTypeMapper.exposedColumnSpec(f))
        assertEquals(STRING, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `string field with dbColumnType=jsonb is case-insensitive`() {
        // `@dbColumnType` lookup case-folds (see `KotlinTypeMapper.dbColumnType`); both
        // `"JSONB"` and `"jsonb"` route to the JSONB branch.
        val f = StringField("featureFlags")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "JSONB"))
        assertEquals("text(\"feature_flags\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `string field with dbColumnType=jsonb ignores maxLength`() {
        // A short `@maxLength` would normally select varchar; the JSONB override wins
        // regardless so a YAML with both attributes still gets the unbounded text column.
        val f = StringField("blob")
        f.addMetaAttr(StringAttribute.create("dbColumnType", "jsonb"))
        f.addMetaAttr(IntAttribute.create("maxLength", 64))
        assertEquals("text(\"blob\")", KotlinTypeMapper.exposedColumnSpec(f))
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

    @Test fun `uuid field (matched by subtype) maps to java util UUID and uuid exposed column`() {
        // `field.uuid` has no dedicated Java class today — mapper matches by subtype name.
        // Use a minimal anonymous PrimitiveField with subType="uuid" to drive the path.
        val f = object : PrimitiveField<String>("uuid", "externalId", DataTypes.STRING) {}
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.util", tn.packageName)
        assertEquals("UUID", tn.simpleName)
        // Column name snake_case-d for Postgres convention.
        assertEquals("uuid(\"external_id\")", KotlinTypeMapper.exposedColumnSpec(f))
    }
}
