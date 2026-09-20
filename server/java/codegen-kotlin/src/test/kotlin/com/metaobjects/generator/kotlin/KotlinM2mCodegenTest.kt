package com.metaobjects.generator.kotlin

import com.metaobjects.`object`.MetaObject
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FR-018 Unit 13 — string-assertion coverage for the Kotlin M:N codegen surface:
 * the controller's {@code GET /{id}/<relationName>} traversal sub-resource and the
 * {@code <Source>Relations.kt} Exposed junction-join query helper. Mirrors the
 * cross-port REST contract from {@code fixtures/api-contract-conformance/m2m/}:
 * hetero ({@code Post}—tags→ {@code Tag} via {@code PostTag}), directed self-join
 * ({@code Person}—following→ {@code Person} via {@code Follow}, {@code @sourceRefField}),
 * and symmetric self-join ({@code Person}—friends→ {@code Person} via
 * {@code Friendship}, {@code @symmetric}). Parallels the Java codegen-spring
 * {@code SpringM2mCodegenTest}.
 */
class KotlinM2mCodegenTest {

    /** The m2m api-contract corpus's original 6-entity model (Post/Tag/PostTag + Person/Follow/Friendship), inlined. */
    private val m2mFixture = """{
      "metadata.root": { "package": "acme::social", "children": [
        { "object.entity": { "name": "Post", "children": [
            { "source.rdb":   { "@table": "posts" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@required": true, "@maxLength": 200 } },
            { "relationship.association": { "name": "tags", "@cardinality": "many",
                "@objectRef": "Tag", "@through": "PostTag" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Tag", "children": [
            { "source.rdb":   { "@table": "tags" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "PostTag", "children": [
            { "source.rdb":         { "@table": "post_tags" } },
            { "field.long":         { "name": "postId", "@required": true } },
            { "field.long":         { "name": "tagId",  "@required": true } },
            { "identity.primary":   { "@fields": ["postId", "tagId"] } },
            { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
            { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
        ] } },
        { "object.entity": { "name": "Person", "children": [
            { "source.rdb":   { "@table": "people" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
            { "relationship.association": { "name": "following", "@cardinality": "many",
                "@objectRef": "Person", "@through": "Follow", "@sourceRefField": "followerId" } },
            { "relationship.association": { "name": "friends", "@cardinality": "many",
                "@objectRef": "Person", "@through": "Friendship", "@symmetric": true } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Follow", "children": [
            { "source.rdb":         { "@table": "follows" } },
            { "field.long":         { "name": "followerId", "@required": true } },
            { "field.long":         { "name": "followeeId", "@required": true } },
            { "identity.primary":   { "@fields": ["followerId", "followeeId"] } },
            { "identity.reference": { "name": "fkFollower", "@fields": "followerId", "@references": "Person" } },
            { "identity.reference": { "name": "fkFollowee", "@fields": "followeeId", "@references": "Person" } }
        ] } },
        { "object.entity": { "name": "Friendship", "children": [
            { "source.rdb":         { "@table": "friendships" } },
            { "field.long":         { "name": "personAId", "@required": true } },
            { "field.long":         { "name": "personBId", "@required": true } },
            { "identity.primary":   { "@fields": ["personAId", "personBId"] } },
            { "identity.reference": { "name": "fkPersonA", "@fields": "personAId", "@references": "Person" } },
            { "identity.reference": { "name": "fkPersonB", "@fields": "personBId", "@references": "Person" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun generate(gen: MultiFileLike, relPath: String): String {
        val outDir = Files.createTempDirectory("km2m-")
        return try {
            gen.run(outDir.toString(), loadStringM2m())
            val f = outDir.resolve(relPath)
            assertTrue(Files.exists(f), "expected generated file $f; files=${Files.walk(outDir).toList()}")
            Files.readString(f)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private fun loadStringM2m() = loadString("km2m", m2mFixture)

    // Tiny adapter so the test can run either generator the same way.
    private fun interface MultiFileLike {
        fun run(outputDir: String, loader: com.metaobjects.loader.MetaDataLoader)
    }

    private val controllerGen = MultiFileLike { outputDir, loader ->
        KotlinSpringControllerGenerator().apply { setArgs(mapOf("outputDir" to outputDir)) }.execute(loader)
    }
    private val relationsGen = MultiFileLike { outputDir, loader ->
        KotlinRelationsGenerator().apply { setArgs(mapOf("outputDir" to outputDir)) }.execute(loader)
    }

    @Test fun heteroControllerEmitsTraversalEndpoint() {
        val src = generate(controllerGen, "acme/social/PostController.kt")
        // Source URL segment is the entity name pluralized (Post -> posts), per the contract.
        assertTrue("@RequestMapping(\"/api/posts\")" in src, "expected /api/posts route base; saw:\n$src")
        assertTrue("@GetMapping(\"/{id}/tags\")" in src, "expected @GetMapping(\"/{id}/tags\"); saw:\n$src")
        assertTrue("fun tags(@PathVariable id: Long): ResponseEntity<List<Tag>>" in src,
            "expected tags() traversal handler returning List<Tag>; saw:\n$src")
        assertTrue("PostTable.tagsQuery(id)" in src, "expected delegation to PostTable.tagsQuery(id); saw:\n$src")
    }

    @Test fun heteroRelationsEmitsJunctionJoinHelper() {
        val src = generate(relationsGen, "acme/social/PostRelations.kt")
        // Join target (Tag) by PK to the junction's derived target FK (tagId), filter on sourceFK (postId).
        assertTrue("fun PostTable.tagsQuery(sourceId: Long): Query" in src,
            "expected tagsQuery helper; saw:\n$src")
        assertTrue("TagTable.join(PostTagTable, JoinType.INNER)" in src,
            "expected INNER join to junction PostTagTable; saw:\n$src")
        assertTrue("TagTable.id eq PostTagTable.tagId" in src,
            "expected join on Tag PK = junction target FK (tagId); saw:\n$src")
        assertTrue("PostTagTable.postId eq sourceId" in src,
            "expected source filter on junction source FK (postId); saw:\n$src")
    }

    @Test fun selfJoinControllerEmitsBothDirectedAndSymmetricEndpoints() {
        val src = generate(controllerGen, "acme/social/PersonController.kt")
        // Source URL segment Person -> persons (per the contract, NOT the physical @table "people").
        assertTrue("@RequestMapping(\"/api/persons\")" in src, "expected /api/persons route base; saw:\n$src")
        assertTrue("@GetMapping(\"/{id}/following\")" in src, "expected /{id}/following; saw:\n$src")
        assertTrue("fun following(@PathVariable id: Long): ResponseEntity<List<Person>>" in src,
            "expected following() handler; saw:\n$src")
        assertTrue("@GetMapping(\"/{id}/friends\")" in src, "expected /{id}/friends; saw:\n$src")
        assertTrue("fun friends(@PathVariable id: Long): ResponseEntity<List<Person>>" in src,
            "expected friends() handler; saw:\n$src")
    }

    @Test fun selfJoinRelationsEmitsDirectedAndSymmetricHelpers() {
        val src = generate(relationsGen, "acme/social/PersonRelations.kt")
        // Directed self-join: filter junction Follow on the @sourceRefField (followerId).
        assertTrue("fun PersonTable.followingQuery(sourceId: Long): Query" in src,
            "expected followingQuery; saw:\n$src")
        assertTrue("FollowTable.followerId eq sourceId" in src,
            "expected directed filter on @sourceRefField followerId; saw:\n$src")
        // Symmetric self-join: union-on-read both junction FK columns, KEEP the self endpoint.
        assertTrue("fun PersonTable.friendsQuery(sourceId: Long): Query" in src,
            "expected friendsQuery; saw:\n$src")
        assertTrue("symmetric — union on read" in src, "expected symmetric marker; saw:\n$src")
        assertTrue("FriendshipTable.personAId eq sourceId" in src &&
            "FriendshipTable.personBId eq sourceId" in src,
            "expected union of both junction FK columns; saw:\n$src")
        // The self-pair (a,a) MUST be retained — Alice is her own friend (matches the runtime
        // M2mJoinResolver + all other ports). The generated query computes the NON-source
        // endpoint per row via a directional ON clause, so it must NOT carry a `neq sourceId`
        // exclusion that would drop the (a,a) row.
        assertFalse("neq sourceId" in src,
            "the symmetric self-join must KEEP the self endpoint (no `neq sourceId` exclusion); saw:\n$src")
        // The directional ON clause pairs each junction FK with the OTHER endpoint binding:
        // one disjunct binds personA to the target PK while personB = sourceId, the mirror
        // disjunct binds personB to the target PK while personA = sourceId. For a self-pair
        // (a,a) BOTH columns equal a, so the source-side eq matches AND the target-PK eq binds
        // to a — the self endpoint is returned, not excluded.
        assertTrue(
            "(FriendshipTable.personAId eq PersonTable.id) and (FriendshipTable.personBId eq sourceId)" in src,
            "expected directional ON clause binding personA to the target and personB to the source; saw:\n$src")
        assertTrue(
            "(FriendshipTable.personBId eq PersonTable.id) and (FriendshipTable.personAId eq sourceId)" in src,
            "expected directional ON clause binding personB to the target and personA to the source; saw:\n$src")
    }

    @Test fun junctionEntityEmitsNoTraversalEndpoint() {
        // The junction (PostTag) is a writable table entity → CRUD controller, but declares
        // no M:N relationship, so no traversal sub-resource.
        val src = generate(controllerGen, "acme/social/PostTagController.kt")
        assertFalse("/{id}/" in src && "Query(id)" in src,
            "junction controller must not emit an M:N traversal endpoint; saw:\n$src")
    }

    // --- Inherited M:N — the declaring-entity follow-up to #368 ---------------------
    //
    // codegen-kotlin reaches the SAME cross-port SSOT (com.metaobjects.relationship
    // .M2MFields.derive) as codegen-spring and omdb, so it carried the same defect:
    // KotlinM2mSupport.resolve walks the RESOLVING `entity.relationships` and passed
    // the entity it was iterating, so a M:N declared on an abstract base and reached
    // through a concrete child was derived against the CHILD. An inherited self-join
    // then read as hetero and threw — and resolve() does NOT catch, so the whole
    // Kotlin generation run failed rather than silently dropping the navigation.
    //
    // This test pins that codegen-kotlin genuinely reaches the fixed helper; the
    // derivation logic itself is gated by the Java M2MSlimVocabularyTest. The child
    // is declared BEFORE the base, the #368 order convention.
    private val inheritedSelfJoinFixture = """{
      "metadata.root": { "package": "acme::graph", "children": [
        { "object.entity": { "name": "Node", "extends": "NodeBase", "children": [
            { "source.rdb":   { "@table": "nodes" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "label", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "NodeBase", "@isAbstract": true, "children": [
            { "relationship.association": { "name": "peers", "@cardinality": "many",
                "@objectRef": "NodeBase", "@through": "NodeLink", "@symmetric": true } }
        ] } },
        { "object.entity": { "name": "NodeLink", "children": [
            { "source.rdb":         { "@table": "node_links" } },
            { "field.long":         { "name": "aId", "@required": true } },
            { "field.long":         { "name": "bId", "@required": true } },
            { "identity.primary":   { "@fields": ["aId", "bId"] } },
            { "identity.reference": { "name": "fkA", "@fields": "aId", "@references": "NodeBase" } },
            { "identity.reference": { "name": "fkB", "@fields": "bId", "@references": "NodeBase" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun inheritedSelfJoinResolvesThroughTheSharedDerivation() {
        val loader = loadString("km2m-inherited", inheritedSelfJoinFixture)
        val node = loader.root.getChildren(MetaObject::class.java, false)
            .first { it.name == "acme::graph::Node" }
        // Pin the premise: the child is reached before the base it inherits from.
        assertEquals(
            listOf("acme::graph::Node", "acme::graph::NodeBase", "acme::graph::NodeLink"),
            loader.root.getChildren(MetaObject::class.java, false).map { it.name },
        )
        val navs = KotlinM2mSupport.resolve(node, loader)
        assertEquals(1, navs.size, "expected the inherited peers navigation; saw $navs")
        assertEquals("peers", navs[0].relationName)
        assertEquals("aId", navs[0].sourceField)
        assertEquals("bId", navs[0].targetField)
        assertTrue(navs[0].symmetric)
    }
}
