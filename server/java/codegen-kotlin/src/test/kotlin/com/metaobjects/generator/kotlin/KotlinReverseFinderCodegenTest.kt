package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ADR-0038 — reverse-relationship navigation via explicit FK finders, Kotlin port:
 * Exposed DSL query functions on the entity HOLDING the FK, emitted into
 * `<Entity>Relations.kt` by [KotlinRelationsGenerator].
 *
 * Loads the shared `reverse-finders-same-pair` model (inlined): `GameSession` holds
 * THREE FKs to `Scene` plus one string-PK FK to `Player`. Asserts the three same-pair
 * Scene FKs yield THREE DISTINCT finder pairs (`findByCurrentScene` /
 * `findByLastOpeningNarrativeScene` / `findByTransitioningFromScene`), each with a
 * single (WHERE fk = ?) + batched (WHERE fk IN (…)) shape — and that this is NOT a
 * lazy Exposed `referrersOn` reverse collection.
 */
class KotlinReverseFinderCodegenTest {

    /** The shared reverse-finders-same-pair model, inlined (3 FKs to Scene + 1 to Player). */
    private val fixture = """{
      "metadata.root": { "package": "game", "children": [
        { "object.entity": { "name": "Scene", "children": [
            { "source.rdb":   { "@table": "scenes" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Player", "children": [
            { "source.rdb":   { "@table": "players" } },
            { "field.string": { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "assigned" } }
        ] } },
        { "object.entity": { "name": "GameSession", "children": [
            { "source.rdb":   { "@table": "game_sessions" } },
            { "field.long":   { "name": "id" } },
            { "field.long":   { "name": "currentSceneId" } },
            { "field.long":   { "name": "lastOpeningNarrativeSceneId" } },
            { "field.long":   { "name": "transitioningFromSceneId" } },
            { "field.string": { "name": "playerId" } },
            { "relationship.association": { "name": "currentScene", "@cardinality": "one", "@objectRef": "Scene" } },
            { "relationship.association": { "name": "player", "@cardinality": "one", "@objectRef": "Player" } },
            { "identity.primary":   { "name": "id", "@fields": "id", "@generation": "increment" } },
            { "identity.reference": { "name": "fkCurrentScene", "@fields": "currentSceneId", "@references": "Scene" } },
            { "identity.reference": { "name": "fkLastOpeningNarrativeScene", "@fields": "lastOpeningNarrativeSceneId", "@references": "Scene" } },
            { "identity.reference": { "name": "fkTransitioningFromScene", "@fields": "transitioningFromSceneId", "@references": "Scene" } },
            { "identity.reference": { "name": "fkPlayer", "@fields": "playerId", "@references": "Player" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun generate(): String {
        val outDir = Files.createTempDirectory("krev-")
        val gen = KotlinRelationsGenerator()
        gen.setArgs(mapOf("outputDir" to outDir.toString()))
        gen.execute(loadString("reverse-finders", fixture))
        val emitted = outDir.resolve("game/GameSessionRelations.kt")
        assertTrue(Files.exists(emitted), "expected $emitted; files=${Files.walk(outDir).toList()}")
        return Files.readString(emitted)
    }

    @Test fun `same-pair three scenes yield three distinct finders`() {
        val src = generate()
        assertTrue("fun GameSessionTable.findByCurrentScene(currentSceneId: Long): Query" in src,
            "expected findByCurrentScene; saw:\n$src")
        assertTrue("fun GameSessionTable.findByLastOpeningNarrativeScene(lastOpeningNarrativeSceneId: Long): Query" in src,
            "expected findByLastOpeningNarrativeScene; saw:\n$src")
        assertTrue("fun GameSessionTable.findByTransitioningFromScene(transitioningFromSceneId: Long): Query" in src,
            "expected findByTransitioningFromScene; saw:\n$src")
    }

    @Test fun `single finder is an indexed WHERE-eq query`() {
        val src = generate()
        assertTrue(
            "GameSessionTable.selectAll().where { GameSessionTable.currentSceneId eq currentSceneId }" in src,
            "expected single indexed WHERE eq body; saw:\n$src")
    }

    @Test fun `batched finder is a WHERE-IN query (anti-N+1)`() {
        val src = generate()
        assertTrue("fun GameSessionTable.findByCurrentSceneIn(currentSceneIds: List<Long>): Query" in src,
            "expected batched findByCurrentSceneIn; saw:\n$src")
        assertTrue(
            "GameSessionTable.selectAll().where { GameSessionTable.currentSceneId inList currentSceneIds }" in src,
            "expected batched WHERE inList body; saw:\n$src")
    }

    @Test fun `string-PK FK uses String value type`() {
        val src = generate()
        assertTrue("fun GameSessionTable.findByPlayer(playerId: String): Query" in src,
            "expected findByPlayer(String); saw:\n$src")
        assertTrue("fun GameSessionTable.findByPlayerIn(playerIds: List<String>): Query" in src,
            "expected findByPlayerIn(List<String>); saw:\n$src")
    }

    @Test fun `not a lazy referrersOn reverse collection`() {
        val src = generate()
        assertFalse("referrersOn" in src,
            "reverse nav must be explicit query fns, not lazy referrersOn; saw:\n$src")
        assertFalse("backReferencedOn" in src,
            "must not use lazy backReferencedOn; saw:\n$src")
    }

    @Test fun `referenced entity emits no relations file`() {
        val outDir = Files.createTempDirectory("krev-")
        val gen = KotlinRelationsGenerator()
        gen.setArgs(mapOf("outputDir" to outDir.toString()))
        gen.execute(loadString("reverse-finders", fixture))
        // Scene + Player hold no FKs (no identity.reference, no to-many) → no relations file.
        assertFalse(Files.exists(outDir.resolve("game/SceneRelations.kt")),
            "Scene holds no FK/to-many → no SceneRelations.kt")
        assertFalse(Files.exists(outDir.resolve("game/PlayerRelations.kt")),
            "Player holds no FK/to-many → no PlayerRelations.kt")
    }

    @Test fun `fk segment derivation drops trailing Id`() {
        assertEquals("CurrentScene", KotlinNaming.reverseFinderFkSegment("currentSceneId"))
        assertEquals("Player", KotlinNaming.reverseFinderFkSegment("playerId"))
        assertEquals("findByCurrentScene", KotlinNaming.reverseFinderName("currentSceneId"))
        assertEquals("findByCurrentSceneIn", KotlinNaming.reverseFinderInName("currentSceneId"))
        assertEquals("Id", KotlinNaming.reverseFinderFkSegment("id"))
    }
}
