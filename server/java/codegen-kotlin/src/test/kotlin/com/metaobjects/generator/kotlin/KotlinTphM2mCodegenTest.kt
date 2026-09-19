package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FW-8 x FR-017 — M:N traversal routes inside a TPH hierarchy, and FW-3 — the target-table
 * redirection an M:N onto a TPH subtype needs. Before this fix:
 *
 *  - `KotlinSpringControllerGenerator.execute()` skipped every TPH subtype and `emitTph()` never
 *    consulted [KotlinM2mSupport] at all, so a base-declared AND a subtype-declared M:N vanished
 *    from the generated TPH controller. `KotlinRelationsGenerator` had the same subtype skip, so
 *    a subtype-own M:N got no `<relationName>Query` Exposed helper either.
 *  - [KotlinM2mSupport.resolve] bound a TPH-subtype TARGET to its own (nonexistent) `<Sub>Table` /
 *    `<Sub>` data class — a real compile failure the moment a self-join onto a subtype (e.g.
 *    `linkedAuths` below) was exercised, since a TPH subtype's ONLY generated class is its
 *    validation-only `<Sub>Validation` shape, never a `<Sub>Table` or a `<Sub>` data class.
 *
 * Model: `Auth` (base, `@discriminator: type`) declares a hetero M:N `tags -> Tag` through
 * `AuthTag` (resolved by the base AND, inherited, by every concrete subtype). `BridgeAuth`
 * additionally declares its own directed self-join M:N `linkedAuths -> BridgeAuth` through
 * `AuthLink` — resolved by Bridge only, and its TARGET is itself a TPH subtype.
 */
class KotlinTphM2mCodegenTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::auth", "children": [
        { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "auths" } },
            { "field.long":   { "name": "id" } },
            { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay"] } },
            { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
            { "relationship.association": { "name": "tags", "@cardinality": "many",
                "@objectRef": "Tag", "@through": "AuthTag" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } },
            { "relationship.association": { "name": "linkedAuths", "@cardinality": "many",
                "@objectRef": "BridgeAuth", "@through": "AuthLink", "@sourceRefField": "fromAuthId" } }
        ] } },
        { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
            { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } }
        ] } },
        { "object.entity": { "name": "Tag", "children": [
            { "source.rdb":   { "@table": "tags" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "AuthTag", "children": [
            { "source.rdb":         { "@table": "auth_tags" } },
            { "field.long":         { "name": "authId", "@required": true } },
            { "field.long":         { "name": "tagId",  "@required": true } },
            { "identity.primary":   { "@fields": ["authId", "tagId"] } },
            { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "Auth" } },
            { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
        ] } },
        { "object.entity": { "name": "AuthLink", "children": [
            { "source.rdb":         { "@table": "auth_links" } },
            { "field.long":         { "name": "fromAuthId", "@required": true } },
            { "field.long":         { "name": "toAuthId",   "@required": true } },
            { "identity.primary":   { "@fields": ["fromAuthId", "toAuthId"] } },
            { "identity.reference": { "name": "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth" } },
            { "identity.reference": { "name": "fkTo",   "@fields": "toAuthId",   "@references": "BridgeAuth" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun loader(): MetaDataLoader = loadString("tph-m2m", fixture)

    private fun generate(run: (String, MetaDataLoader) -> Unit, relPath: String): String {
        val outDir = Files.createTempDirectory("ktph-m2m-")
        return try {
            run(outDir.toString(), loader())
            val f = outDir.resolve(relPath)
            assertTrue(Files.exists(f), "expected generated file $f; files=${Files.walk(outDir).toList()}")
            Files.readString(f)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private fun controller(): String = generate(
        { outDir, ld -> KotlinSpringControllerGenerator().apply { setArgs(mapOf("outputDir" to outDir)) }.execute(ld) },
        "acme/auth/AuthController.kt",
    )

    private fun relations(): String = generate(
        { outDir, ld -> KotlinRelationsGenerator().apply { setArgs(mapOf("outputDir" to outDir)) }.execute(ld) },
        "acme/auth/AuthRelations.kt",
    )

    // --- controller: base-level mount (rule a) ------------------------------

    @Test fun baseDeclaredRelationMountsUnscopedAtTheBasePath() {
        val src = controller()
        assertTrue("@GetMapping(\"/{id}/tags\")" in src, "expected base-level /{id}/tags; saw:\n$src")
        assertTrue("fun tags(@PathVariable id: Long): ResponseEntity<List<Tag>>" in src,
            "expected unscoped tags() handler returning List<Tag>; saw:\n$src")
        assertTrue("AuthTable.tagsQuery(id)" in src, "expected delegation to AuthTable.tagsQuery(id); saw:\n$src")
    }

    // --- controller: inherited relation mounted again under each subtype (rule b) ---

    @Test fun inheritedRelationIsAlsoMountedUnderEachSubtypeSegmentWithAGate() {
        val src = controller()
        assertTrue("@GetMapping(\"/bridge/{id}/tags\")" in src, "expected /bridge/{id}/tags; saw:\n$src")
        assertTrue("fun tagsBridge(@PathVariable id: Long): ResponseEntity<List<Tag>>" in src,
            "expected tagsBridge() handler; saw:\n$src")
        assertTrue("@GetMapping(\"/copay/{id}/tags\")" in src, "expected /copay/{id}/tags; saw:\n$src")
        assertTrue("fun tagsCopay(@PathVariable id: Long): ResponseEntity<List<Tag>>" in src,
            "expected tagsCopay() handler; saw:\n$src")
        // Rule (c): Stage 0 verifies the source id names a row of THIS subtype before the SAME
        // AuthTable.tagsQuery(id) helper the base mount uses — a sibling's id must return [].
        assertTrue(
            "if (AuthTable.selectAll().where { (AuthTable.id eq id) and (AuthTable.type eq AuthType.Bridge) }.singleOrNull() == null) {" in src,
            "expected Bridge Stage-0 discriminator gate; saw:\n$src",
        )
        assertTrue("return@transaction ResponseEntity.ok(emptyList<Tag>())" in src,
            "expected an EMPTY list (not 404) on a Stage-0 mismatch; saw:\n$src")
        assertTrue("AuthTable.tagsQuery(id)" in src.substringAfter("fun tagsBridge"),
            "expected tagsBridge to reuse the SAME AuthTable.tagsQuery helper; saw:\n$src")
    }

    // --- controller + relations: subtype-own relation, self-join onto a TPH subtype (FW-3) ---

    @Test fun subtypeOwnRelationMountsOnlyUnderItsOwnSegment() {
        val src = controller()
        assertTrue("@GetMapping(\"/bridge/{id}/linkedAuths\")" in src,
            "expected /bridge/{id}/linkedAuths; saw:\n$src")
        // FW-3: the target (BridgeAuth) has no data class of its own — rows map into the STORAGE
        // object's type, Auth (the union type), never a nonexistent `BridgeAuth` class.
        assertTrue("fun linkedAuthsBridge(@PathVariable id: Long): ResponseEntity<List<Auth>>" in src,
            "expected linkedAuthsBridge() returning List<Auth> (the storage/union type); saw:\n$src")
        assertFalse("List<BridgeAuth>" in src, "BridgeAuth has no data class to reference; saw:\n$src")
        // linkedAuths is declared on BridgeAuth only — Copay never resolves it.
        assertFalse("/copay/{id}/linkedAuths" in src, "Copay must not mount linkedAuths; saw:\n$src")
        assertFalse("linkedAuthsCopay" in src, "Copay must not get a linkedAuths handler; saw:\n$src")
    }

    @Test fun subtypeOwnRelationTargetingASubtypeBindsToTheStorageTableAndFiltersByDiscriminator() {
        val src = relations()
        // FW-3: the join binds AuthTable (the storage object), never a nonexistent BridgeAuthTable.
        assertTrue("fun AuthTable.linkedAuthsQuery(sourceId: Long): Query" in src,
            "expected linkedAuthsQuery on AuthTable; saw:\n$src")
        assertFalse("BridgeAuthTable" in src, "BridgeAuthTable does not exist; saw:\n$src")
        assertTrue("AuthTable.join(AuthLinkTable, JoinType.INNER) { AuthTable.id eq AuthLinkTable.toAuthId }" in src,
            "expected the join keyed on AuthTable's own PK; saw:\n$src")
        // The shared table's join returns EVERY subtype's rows reachable through the junction —
        // this AND is what narrows it back to just BridgeAuth's own rows (the declared target).
        assertTrue(
            ".where { (AuthLinkTable.fromAuthId eq sourceId) and (AuthTable.type eq AuthType.Bridge) }" in src,
            "expected the source filter ANDed with a target discriminator filter; saw:\n$src",
        )
    }

    @Test fun baseDeclaredRelationOntoAPlainEntityGetsNoDiscriminatorFilter() {
        val src = relations()
        // "tags" targets Tag, a plain (non-TPH) entity — no filter, unaffected by this fix.
        assertTrue("fun AuthTable.tagsQuery(sourceId: Long): Query" in src, "expected tagsQuery; saw:\n$src")
        val tagsFn = src.substringAfter("fun AuthTable.tagsQuery").substringBefore("fun AuthTable.linkedAuthsQuery")
        assertFalse("AuthType" in tagsFn, "tagsQuery must not reference the discriminator enum; saw:\n$tagsFn")
    }

    @Test fun polymorphicAndPerSubtypeCrudMountsAreStillEmitted() {
        val src = controller()
        assertTrue("@RequestMapping(\"/api/auths\")" in src)
        assertTrue("@GetMapping(\"/bridge\")" in src)
        assertTrue("@GetMapping(\"/copay\")" in src)
    }
}
