/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * FR-003 Plan 4 (Debt 3) — transaction template callback.
 */
package com.metaobjects.manager;

import java.sql.SQLException;

/**
 * Work executed inside an {@link ObjectManager#inTransaction} scope.
 *
 * <p>Pattern: matches Spring {@code TransactionCallback<T>} and jOOQ
 * {@code TransactionalCallable<T>} — a named, single-method, generic-typed
 * functional interface, deliberately not {@code java.util.function.Function}
 * (a) so JDBC checked exceptions in the lambda are first-class instead of
 * forced wrap/unwrap and (b) so call sites are grep-able by symbol name.
 *
 * <p>Semantics: a normal return commits the transaction and yields the
 * value; any thrown exception (checked or runtime) rolls back and rethrows.
 *
 * @param <T> return type
 */
@FunctionalInterface
public interface TransactionWork<T> {
    T apply(ObjectConnection conn) throws SQLException;
}
