package com.metaobjects.generator.kotlin

import com.metaobjects.config.MigrateSettings
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `migrate.foreignKeyIndexes` (.metaobjects/config.json, carried on the loaded root as
 * [MigrateSettings]): `meta migrate` gives every enforced foreign key that nothing already leads
 * with a `<table>_<columns>_idx` index, so the Exposed table declares the same index under the
 * same name. The model is the one migrate-ts's expected-schema-foreign-key-indexes test builds.
 */
class KotlinExposedForeignKeyIndexTest {

    private val fixture = """{
      "metadata.root": { "package": "acme", "children": [
        { "object.entity": { "name": "Customer", "children": [
          { "source.rdb": { "@table": "customers" } },
          { "field.long": { "name": "id" } },
          { "field.string": { "name": "code" } },
          { "identity.primary": { "name": "pk", "@fields": "id" } },
          { "identity.secondary": { "name": "customers_code_key", "@fields": ["code"] } }
        ] } },
        { "object.entity": { "name": "Order", "children": [
          { "source.rdb": { "@table": "orders" } },
          { "field.long": { "name": "id" } },
          { "field.long": { "name": "customerId", "@column": "customer_id" } },
          { "field.long": { "name": "billToId", "@column": "bill_to_id" } },
          { "field.string": { "name": "customerCode", "@column": "customer_code" } },
          { "identity.primary": { "name": "pk", "@fields": "id" } },
          { "identity.reference": { "name": "customer", "@fields": ["customerId"], "@references": "Customer" } },
          { "identity.reference": { "name": "billTo", "@fields": ["billToId"], "@references": "Customer" } },
          { "identity.reference": { "name": "byCode", "@fields": ["customerCode"], "@references": "Customer.code" } },
          { "index.lookup": { "name": "orders_bill_to", "@fields": ["billToId", "id"] } }
        ] } },
        { "object.entity": { "name": "OrderTag", "children": [
          { "source.rdb": { "@table": "order_tags" } },
          { "field.long": { "name": "orderId", "@column": "order_id" } },
          { "field.long": { "name": "tagId", "@column": "tag_id" } },
          { "identity.primary": { "name": "pk", "@fields": ["orderId", "tagId"] } },
          { "identity.reference": { "name": "order", "@fields": ["orderId"], "@references": "Order" } },
          { "identity.reference": { "name": "tag", "@fields": ["tagId"], "@references": "Tag" } }
        ] } },
        { "object.entity": { "name": "Tag", "children": [
          { "source.rdb": { "@table": "tags" } },
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": "id" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun tables(settings: MigrateSettings): String {
        val outDir = Files.createTempDirectory("ktbl-fkidx-")
        try {
            val loader = loadString("fk-idx", fixture)
            loader.root.setMigrateSettings(settings)
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)
            return listOf("OrderTable.kt", "OrderTagTable.kt")
                .joinToString("\n") { Files.readString(outDir.resolve("acme/$it")) }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `off, the table declares no foreign key index`() {
        assertFalse("_idx\"" in tables(MigrateSettings.DEFAULT))
    }

    @Test fun `on, each foreign key nothing leads with gets migrate's index`() {
        val src = tables(MigrateSettings(true, null, null))
        assertTrue("index(\"orders_customer_id_idx\", false, customerId)" in src, src)
        assertTrue("index(\"orders_customer_code_idx\", false, customerCode)" in src, src)
        assertTrue("index(\"order_tags_tag_id_idx\", false, tagId)" in src, src)
        // Led by a declared lookup index, and by the junction's primary key.
        assertFalse("orders_bill_to_id_idx" in src, src)
        assertFalse("order_tags_order_id_idx" in src, src)
    }

    @Test fun `the efcore conventions and mysql add nothing`() {
        assertFalse("_idx\"" in tables(MigrateSettings(true, "efcore", null)))
        assertFalse("_idx\"" in tables(MigrateSettings(true, null, "mysql")))
    }
}
