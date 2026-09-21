package com.metaobjects.generator.spring.runtime;

import java.util.List;
import java.util.Objects;

/**
 * Outcome of {@link FilterParser#parse}: either a list of validated
 * predicates ({@code error == null}), or a cross-port error envelope key
 * ({@code predicates} is empty + {@code error} is one of
 * {@code invalid_filter_field} / {@code invalid_filter_op} /
 * {@code invalid_filter_value}) plus the {@code field} it is about.
 *
 * <p>{@code field} is non-null exactly when {@code error} is — the cross-port
 * envelope names the rejected field so a caller sending several filters does
 * not have to guess which one failed. The generated controller reads it
 * straight into the 400 body, which is why {@link #err} rejects a null field
 * at construction rather than letting it surface as a 500 from {@code Map.of}.
 */
public record FilterParseResult(List<FilterPredicate> predicates, String error, String field) {

    /** Success path: a list of (possibly empty) predicates. */
    public static FilterParseResult ok(List<FilterPredicate> predicates) {
        return new FilterParseResult(predicates, null, null);
    }

    /** Error path: cross-port envelope key + the offending field (no predicates). */
    public static FilterParseResult err(String error, String field) {
        return new FilterParseResult(List.of(), error, Objects.requireNonNull(field, "field"));
    }
}
