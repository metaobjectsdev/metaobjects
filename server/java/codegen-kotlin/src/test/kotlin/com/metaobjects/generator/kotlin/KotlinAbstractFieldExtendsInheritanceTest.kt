package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ADR-0039 (own-accessor discipline — resolving is the default) regression guard for the
 * Kotlin codegen. Complements [KotlinProjectionExtendsInheritanceTest] (projection-field
 * `extends:`) with the two shapes ADR-0039 calls out that broke under own-only reads:
 *
 *   1. A CONCRETE entity that inherits its `source.rdb` from an abstract BaseEntity via
 *      `extends:` must still generate an Exposed table. Pre-fix, every generator resolved
 *      the source with a raw `entity.children.filterIsInstance<RdbSource>()` own-only read
 *      and emitted NOTHING for such an entity (the high-blast-radius bug). The fix routes
 *      source lookups through the resolving `MetaObject.getSources(true)` (KotlinGenUtil.
 *      firstRdbSource / hasRdbSource).
 *
 *   2. A CONCRETE field that `extends:` an abstract array field (`isArray:true`) or an
 *      abstract decimal field (`@precision`/`@scale`) must inherit those EFFECTIVE
 *      properties. Pre-fix, `KotlinExtractSchemaEmitter`/`KotlinOutputFormatSpecEmitter`
 *      read the raw native `field.isArray` flag (own-only) and `KotlinTypeMapper.intAttr`
 *      read `@precision`/`@scale` own-only, so an extends-bound field lost its array-ness /
 *      precision. The fix routes array-ness through the resolving `MetaField.isArrayType()`
 *      and makes `intAttr` resolve through `extends` (like `stringMaxLength`).
 */
class KotlinAbstractFieldExtendsInheritanceTest {

    // Abstract shared fields (array-string + decimal) declared at root, plus an abstract
    // BaseEntity carrying the `source.rdb`. `Contact` extends BaseEntity (inherits the
    // source) and its `tags`/`balance` fields extend the abstract fields (inherit isArray /
    // precision+scale). NOTHING physical is restated on Contact.
    private val fixture = """{
      "metadata.root": { "package": "acme", "children": [
        { "field.string":  { "name": "Tags",  "abstract": true, "isArray": true, "@maxLength": 40 } },
        { "field.decimal": { "name": "Money", "abstract": true, "@precision": 12, "@scale": 2 } },
        { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
            { "field.string":     { "name": "id", "@required": true, "@dbColumnType": "uuid" } },
            { "source.rdb":       { "@table": "contacts" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "uuid" } }
        ] } },
        { "object.entity": { "name": "Contact", "extends": "acme::BaseEntity", "children": [
            { "field.string":  { "name": "name",    "@required": true } },
            { "field.string":  { "name": "tags",    "extends": "acme::Tags" } },
            { "field.decimal": { "name": "balance", "extends": "acme::Money" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `entity inheriting source and fields extending abstract array-decimal generate correctly`() {
        val outDir = Files.createTempDirectory("kabs-extends-")
        try {
            val loader = loadString("abstract-field-extends", fixture)
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            // (1) The entity inherits its source.rdb via extends → a table MUST be emitted.
            val tableKt = outDir.resolve("acme/ContactTable.kt")
            assertTrue(Files.exists(tableKt),
                "entity inheriting source.rdb via extends must still emit an Exposed table $tableKt;" +
                    " files=${Files.walk(outDir).toList()}")
            val table = Files.readString(tableKt)

            // (2a) `tags` extends the abstract array field → array<String> column (inherited isArray).
            assertTrue("val tags = array<String>(\"tags\"" in table,
                "tags must inherit isArray:true from the abstract Tags field (array<String>); saw:\n$table")
            assertFalse("val tags = varchar(\"tags\"" in table || "val tags = text(\"tags\")" in table,
                "tags must NOT fall back to a scalar column when array-ness is inherited; saw:\n$table")

            // (2b) `balance` extends the abstract decimal field → decimal(col, 12, 2) (inherited p/s).
            assertTrue("val balance = decimal(\"balance\", 12, 2)" in table,
                "balance must inherit @precision=12/@scale=2 from the abstract Money field; saw:\n$table")
            assertFalse("decimal(\"balance\", 19, 4)" in table,
                "balance must NOT fall back to the default NUMERIC(19,4) — precision/scale are inherited; saw:\n$table")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
