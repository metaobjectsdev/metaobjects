package com.metaobjects.generator.spring.runtime;

/**
 * A single parsed + validated filter predicate produced by
 * {@link FilterParser#parse}. Carries the field name, the operator (one of
 * the 9 cross-port FR-009 ops: {@code eq, ne, gt, gte, lt, lte, in, like,
 * isNull}), and the coerced value (a {@code String} for the scalar ops, a
 * {@code List<String>} for {@code in}, a {@code Boolean} for {@code isNull}).
 *
 * <p>The repository implementation is responsible for translating this into
 * its persistence DSL — there is no built-in JPA / jOOQ binding here so the
 * runtime stays substrate-agnostic.</p>
 */
public record FilterPredicate(String field, String op, Object value) {}
