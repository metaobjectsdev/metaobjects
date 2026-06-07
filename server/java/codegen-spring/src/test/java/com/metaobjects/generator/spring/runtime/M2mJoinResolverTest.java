package com.metaobjects.generator.spring.runtime;

import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;

/**
 * FR-018 Unit 12 — reference-lane semantics for the M:N junction-traversal
 * helper. Mirrors the cross-port api-contract m2m scenarios exactly (same seed,
 * same expected related ids), proving the three resolution modes independent of
 * any generated code or persistence layer:
 *
 * <ul>
 *   <li><b>hetero</b>: PostTag rows (postId→tagId). Post 1 → tags {10,20};
 *       Post 2 → {30}; Post 3 → {} (orphan).</li>
 *   <li><b>directed self-join</b>: Follow rows filtered to followerId=:id, related =
 *       followeeId. Person 1 → {2,3}; Person 2 → {1}; Person 3 → {} (no outbound).</li>
 *   <li><b>symmetric self-join</b>: Friendship rows where personAId=:id OR
 *       personBId=:id, related = the non-source column. Person 1 → {2,3};
 *       Person 2 → {1,4}; Person 4 → {2}.</li>
 * </ul>
 *
 * Seed (from {@code fixtures/api-contract-conformance/m2m/seed.json}):
 * post_tags = (1,10),(1,20),(2,30); follows = (1,2),(1,3),(2,1);
 * friendships = (1,2),(3,1),(2,4).
 */
public class M2mJoinResolverTest {

    // --- hetero (PostTag) ---------------------------------------------------

    private static final List<JunctionRow> POST_TAGS = List.of(
        new JunctionRow(1L, 10L), new JunctionRow(1L, 20L), new JunctionRow(2L, 30L));

    /** Filter the junction to sourceField = id (what the consumer's WHERE does). */
    private static List<JunctionRow> directedFor(List<JunctionRow> all, long sourceId) {
        List<JunctionRow> out = new ArrayList<>();
        for (JunctionRow r : all) if (M2mJoinResolver.keyEquals(r.sourceKey(), sourceId)) out.add(r);
        return out;
    }

    /** Filter the junction to sourceField = id OR targetField = id (symmetric union). */
    private static List<JunctionRow> symmetricFor(List<JunctionRow> all, long id) {
        List<JunctionRow> out = new ArrayList<>();
        for (JunctionRow r : all)
            if (M2mJoinResolver.keyEquals(r.sourceKey(), id) || M2mJoinResolver.keyEquals(r.targetKey(), id))
                out.add(r);
        return out;
    }

    @Test
    public void heteroResolvesRelatedTagIds() {
        assertEquals(List.of(10L, 20L),
            M2mJoinResolver.relatedKeys(1L, directedFor(POST_TAGS, 1L), false));
        assertEquals(List.of(30L),
            M2mJoinResolver.relatedKeys(2L, directedFor(POST_TAGS, 2L), false));
        assertEquals(List.of(),
            M2mJoinResolver.relatedKeys(3L, directedFor(POST_TAGS, 3L), false));
    }

    // --- directed self-join (Follow: followerId = source) -------------------

    private static final List<JunctionRow> FOLLOWS = List.of(
        new JunctionRow(1L, 2L), new JunctionRow(1L, 3L), new JunctionRow(2L, 1L));

    @Test
    public void directedSelfJoinHonorsDirection() {
        assertEquals(List.of(2L, 3L),
            M2mJoinResolver.relatedKeys(1L, directedFor(FOLLOWS, 1L), false));
        assertEquals(List.of(1L),
            M2mJoinResolver.relatedKeys(2L, directedFor(FOLLOWS, 2L), false));
        // Person 3 follows nobody (only followed) — direction matters.
        assertEquals(List.of(),
            M2mJoinResolver.relatedKeys(3L, directedFor(FOLLOWS, 3L), false));
    }

    // --- symmetric self-join (Friendship: union both columns) ---------------

    private static final List<JunctionRow> FRIENDSHIPS = List.of(
        new JunctionRow(1L, 2L), new JunctionRow(3L, 1L), new JunctionRow(2L, 4L));

    @Test
    public void symmetricSelfJoinUnionsOnRead() {
        // Person 1: stored (1,2) forward + (3,1) reverse → {2,3}.
        assertEquals(List.of(2L, 3L),
            M2mJoinResolver.relatedKeys(1L, symmetricFor(FRIENDSHIPS, 1L), true));
        // Person 2: (1,2) reverse + (2,4) forward → {1,4}.
        assertEquals(List.of(1L, 4L),
            M2mJoinResolver.relatedKeys(2L, symmetricFor(FRIENDSHIPS, 2L), true));
        // Person 4: (2,4) reverse → {2}.
        assertEquals(List.of(2L),
            M2mJoinResolver.relatedKeys(4L, symmetricFor(FRIENDSHIPS, 4L), true));
    }
}
