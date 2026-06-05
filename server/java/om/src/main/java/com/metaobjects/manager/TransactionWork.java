/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*
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
