package com.metaobjects.generator.spring.runtime;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * FR-018 generic M:N junction-traversal helper for the generated Spring
 * repository layer. Substrate-agnostic: it operates purely on junction rows
 * already loaded by the consumer's persistence layer (Spring Data JPA / jOOQ /
 * plain JDBC), so it carries no JDBC / JPA dependency and stays on the same
 * runtime classpath as {@link FilterParser} / {@link FilterPredicate}.
 *
 * <p>This is the codegen-runtime mirror of the OMDB {@code M2MResolver} and the
 * TS {@code n2m-resolver}: given the derived junction FK field names
 * ({@code sourceField} / {@code targetField}) and the symmetric flag, it returns
 * the DISTINCT related target keys for a source id. The three resolution modes
 * collapse to a single algorithm here because the FK-field derivation
 * ({@code M2MFields.derive}, codegen-time) has already disambiguated direction:</p>
 * <ol>
 *   <li><b>Hetero / directed self-join</b> (not symmetric): the consumer queries
 *       the junction {@code WHERE sourceField = :id}; for each row the related key
 *       is {@code targetField}.</li>
 *   <li><b>Symmetric self-join</b>: the consumer queries the junction
 *       {@code WHERE sourceField = :id OR targetField = :id}; for each row the
 *       related key is whichever FK column is NOT the source id (union-on-read,
 *       single-row storage).</li>
 * </ol>
 *
 * <p>Keys are compared by string-coerced identity so a {@code BIGINT} surfaced as
 * a different numeric type by the driver still matches the in-process source id —
 * the same bridge the cross-port resolvers use.</p>
 */
public final class M2mJoinResolver {

    private M2mJoinResolver() { /* no instances */ }

    /**
     * A loaded junction row, reduced to its two derived FK column values.
     *
     * @param sourceKey value of the source-side FK column on this junction row
     * @param targetKey value of the target-side FK column on this junction row
     */
    public record JunctionRow(Object sourceKey, Object targetKey) {}

    /**
     * Collect the DISTINCT related target keys for {@code sourceId} from the
     * already-fetched junction rows, in first-seen order.
     *
     * <p>For the non-symmetric modes the consumer is expected to have filtered the
     * junction to {@code sourceField = sourceId}, so every row contributes its
     * {@code targetKey}. For the symmetric mode the consumer fetches both
     * directions ({@code sourceField = id OR targetField = id}) and this helper
     * returns, per row, the column that is NOT the source id.</p>
     *
     * @param sourceId   the source entity's key
     * @param rows       junction rows (already filtered for the source id)
     * @param symmetric  {@code true} for an undirected self-join
     * @return the distinct related target keys (empty when none)
     */
    public static List<Object> relatedKeys(Object sourceId, List<JunctionRow> rows, boolean symmetric) {
        Set<Object> out = new LinkedHashSet<>();
        for (JunctionRow row : rows) {
            Object related;
            if (symmetric) {
                related = keyEquals(row.sourceKey(), sourceId) ? row.targetKey() : row.sourceKey();
            } else {
                related = row.targetKey();
            }
            if (related != null) out.add(related);
        }
        return new ArrayList<>(out);
    }

    /** String-coerced key identity — bridges driver-numeric vs in-process-numeric mismatches. */
    public static boolean keyEquals(Object a, Object b) {
        if (a == null || b == null) return a == b;
        return String.valueOf(a).equals(String.valueOf(b));
    }
}
