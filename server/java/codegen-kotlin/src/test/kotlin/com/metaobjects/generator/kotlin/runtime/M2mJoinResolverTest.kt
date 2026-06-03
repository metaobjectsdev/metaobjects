package com.metaobjects.generator.kotlin.runtime

import com.metaobjects.generator.kotlin.runtime.M2mJoinResolver.JunctionRow
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * FR-018 Unit 13 — reference-lane semantics for the Kotlin M:N junction-traversal
 * helper. Mirrors the cross-port api-contract m2m scenarios exactly (same seed,
 * same expected related ids — see `fixtures/api-contract-conformance/m2m/seed.json`),
 * proving the three resolution modes independent of any generated code or
 * persistence layer. Byte-parallel to the Java codegen-spring `M2mJoinResolverTest`.
 *
 * Seed: post_tags = (1,10),(1,20),(2,30); follows = (1,2),(1,3),(2,1);
 * friendships = (1,2),(3,1),(2,4).
 */
class M2mJoinResolverTest {

    // --- hetero (PostTag) ---------------------------------------------------

    private val postTags = listOf(
        JunctionRow(1L, 10L), JunctionRow(1L, 20L), JunctionRow(2L, 30L))

    /** Filter the junction to sourceField = id (what the consumer's WHERE does). */
    private fun directedFor(all: List<JunctionRow>, sourceId: Long): List<JunctionRow> =
        all.filter { M2mJoinResolver.keyEquals(it.sourceKey, sourceId) }

    /** Filter the junction to sourceField = id OR targetField = id (symmetric union). */
    private fun symmetricFor(all: List<JunctionRow>, id: Long): List<JunctionRow> =
        all.filter { M2mJoinResolver.keyEquals(it.sourceKey, id) || M2mJoinResolver.keyEquals(it.targetKey, id) }

    @Test fun heteroResolvesRelatedTagIds() {
        assertEquals(listOf<Any?>(10L, 20L),
            M2mJoinResolver.relatedKeys(1L, directedFor(postTags, 1L), false))
        assertEquals(listOf<Any?>(30L),
            M2mJoinResolver.relatedKeys(2L, directedFor(postTags, 2L), false))
        assertEquals(listOf<Any?>(),
            M2mJoinResolver.relatedKeys(3L, directedFor(postTags, 3L), false))
    }

    // --- directed self-join (Follow: followerId = source) -------------------

    private val follows = listOf(
        JunctionRow(1L, 2L), JunctionRow(1L, 3L), JunctionRow(2L, 1L))

    @Test fun directedSelfJoinHonorsDirection() {
        assertEquals(listOf<Any?>(2L, 3L),
            M2mJoinResolver.relatedKeys(1L, directedFor(follows, 1L), false))
        assertEquals(listOf<Any?>(1L),
            M2mJoinResolver.relatedKeys(2L, directedFor(follows, 2L), false))
        // Person 3 follows nobody (only followed) — direction matters.
        assertEquals(listOf<Any?>(),
            M2mJoinResolver.relatedKeys(3L, directedFor(follows, 3L), false))
    }

    // --- symmetric self-join (Friendship: union both columns) ---------------

    private val friendships = listOf(
        JunctionRow(1L, 2L), JunctionRow(3L, 1L), JunctionRow(2L, 4L))

    @Test fun symmetricSelfJoinUnionsOnRead() {
        // Person 1: stored (1,2) forward + (3,1) reverse → {2,3}.
        assertEquals(listOf<Any?>(2L, 3L),
            M2mJoinResolver.relatedKeys(1L, symmetricFor(friendships, 1L), true))
        // Person 2: (1,2) reverse + (2,4) forward → {1,4}.
        assertEquals(listOf<Any?>(1L, 4L),
            M2mJoinResolver.relatedKeys(2L, symmetricFor(friendships, 2L), true))
        // Person 4: only (2,4) → {2}.
        assertEquals(listOf<Any?>(2L),
            M2mJoinResolver.relatedKeys(4L, symmetricFor(friendships, 4L), true))
    }

    @Test fun keyEqualsBridgesNumericTypeMismatch() {
        // Driver may surface a BIGINT as Int/BigInteger; string-coerce bridges it.
        assertEquals(true, M2mJoinResolver.keyEquals(1L, 1))
        assertEquals(true, M2mJoinResolver.keyEquals(java.math.BigInteger.valueOf(5), 5L))
        assertEquals(false, M2mJoinResolver.keyEquals(1L, 2L))
    }
}
