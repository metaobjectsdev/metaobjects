package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #368 — an entity may legally declare more than one `identity.reference` onto the
 * SAME target (`Match.homeTeamRef` and `Match.awayTeamRef`, both -> `Team`).
 *
 * `KotlinExposedTableGenerator`'s ADR-0047 referential-action correlation had the
 * defect the TS `migrate-ts` engine and the C# `ReferentialActions` port were fixed
 * for: tier 2 matched a sibling relationship on the TARGET ALONE, so every FK past
 * the first silently inherited the FIRST relationship's `@onDelete` / `@onUpdate`,
 * and tier 3 took the first reverse relationship instead of failing closed. The
 * emitted Exposed table compiles and the database accepts the DDL — the only symptom
 * is the wrong referential action on the wrong FK.
 */
class KotlinExposedTableTwoRefsTest {

    /**
     * Tier 2 (child-side correlation). `homeTeam` declares `@onDelete: restrict`,
     * `awayTeam` declares `@onDelete: cascade`; each must land on ITS OWN FK column.
     * Before the fix both columns carried RESTRICT — the first relationship's action.
     *
     * The relationships resolve by ladder step 3 (name pairing: `homeTeam` pairs with
     * `homeTeamRef` / `homeTeamId`), so the model loads clean with no `@sourceRefField`.
     */
    @Test fun `each FK carries its own relationship's referential actions`() {
        val model = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Team", "children": [
                { "field.long": { "name": "id" } },
                { "source.rdb": { "@table": "teams" } },
                { "identity.primary": { "@fields": "id" } }
            ] } },
            { "object.entity": { "name": "Match", "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "homeTeamId" } },
                { "field.long": { "name": "awayTeamId" } },
                { "source.rdb": { "@table": "matches" } },
                { "identity.primary": { "@fields": "id" } },
                { "identity.reference": { "name": "homeTeamRef",
                    "@fields": "homeTeamId", "@references": "Team" } },
                { "identity.reference": { "name": "awayTeamRef",
                    "@fields": "awayTeamId", "@references": "Team" } },
                { "relationship.association": { "name": "homeTeam", "@objectRef": "Team",
                    "@cardinality": "one", "@onDelete": "restrict" } },
                { "relationship.association": { "name": "awayTeam", "@objectRef": "Team",
                    "@cardinality": "one", "@onDelete": "cascade" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-368-tier2-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("issue368-tier2", model))

            val src = Files.readString(outDir.resolve("x/MatchTable.kt"))
            assertTrue(
                ("val homeTeamId = long(\"home_team_id\").references(TeamTable.id, " +
                    "onDelete = ReferenceOption.RESTRICT, onUpdate = ReferenceOption.CASCADE)") in src,
                "expected homeTeamId to carry homeTeam's @onDelete: restrict; saw:\n$src",
            )
            assertTrue(
                ("val awayTeamId = long(\"away_team_id\").references(TeamTable.id, " +
                    "onDelete = ReferenceOption.CASCADE, onUpdate = ReferenceOption.CASCADE)") in src,
                "expected awayTeamId to carry awayTeam's OWN @onDelete: cascade, not " +
                    "homeTeam's restrict (the #368 defect); saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Tier 3 (parent-side reverse correlation) fails closed. `Team` declares TWO
     * non-`@through` relationships back at `Match` — a `cascade` composition and a
     * `restrict` association — and `Match` declares no relationship of its own, so
     * tier 2 contributes nothing and tier 3 must choose. It cannot: neither candidate
     * is preferred, so the FK is emitted BARE rather than arbitrarily armed with the
     * first one's CASCADE.
     */
    @Test fun `an ambiguous reverse relationship contributes no referential action`() {
        val model = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Team", "children": [
                { "field.long": { "name": "id" } },
                { "source.rdb": { "@table": "teams" } },
                { "identity.primary": { "@fields": "id" } },
                { "relationship.composition": { "name": "matches", "@objectRef": "Match",
                    "@cardinality": "many", "@onDelete": "cascade" } },
                { "relationship.association": { "name": "playedMatches", "@objectRef": "Match",
                    "@cardinality": "many", "@onDelete": "restrict" } }
            ] } },
            { "object.entity": { "name": "Match", "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "teamId" } },
                { "source.rdb": { "@table": "matches" } },
                { "identity.primary": { "@fields": "id" } },
                { "identity.reference": { "name": "teamRef",
                    "@fields": "teamId", "@references": "Team" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-368-tier3-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("issue368-tier3", model))

            val src = Files.readString(outDir.resolve("x/MatchTable.kt"))
            assertTrue(
                "val teamId = long(\"team_id\").references(TeamTable.id).nullable()" in src ||
                    "val teamId = long(\"team_id\").references(TeamTable.id)" in src,
                "expected a bare .references(TeamTable.id) FK; saw:\n$src",
            )
            assertTrue(
                "ReferenceOption" !in src,
                "an ambiguous reverse relationship must contribute NO referential action " +
                    "rather than the first candidate's; saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
