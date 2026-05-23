package com.metaobjects.omdb.ktx

import com.metaobjects.manager.QueryBuilder
import com.metaobjects.manager.exp.Expression
import com.metaobjects.`object`.MetaObject

/**
 * A thin wrapper around a field name that provides infix operator syntax for building
 * [Expression]s without coupling the call site to raw constructor calls.
 */
@JvmInline
value class FieldRef(val name: String)

/** Factory function: `field("quantity")` */
fun field(name: String) = FieldRef(name)

infix fun FieldRef.eq(value: Any?)  = Expression(name, value, Expression.EQUAL)
infix fun FieldRef.ne(value: Any?)  = Expression(name, value, Expression.NOT_EQUAL)
infix fun FieldRef.gt(value: Any?)  = Expression(name, value, Expression.GREATER)
infix fun FieldRef.lt(value: Any?)  = Expression(name, value, Expression.LESSER)
infix fun FieldRef.gte(value: Any?) = Expression(name, value, Expression.EQUAL_GREATER)
infix fun FieldRef.lte(value: Any?) = Expression(name, value, Expression.EQUAL_LESSER)

// Note: Expression already has instance methods `and(Expression)` and `or(Expression)`.
// Kotlin treats any single-parameter method as a valid infix call, so callers can write
// `(field("a") eq 1) and (field("b") gt 2)` without any additional declarations here.

/**
 * Executes a query on the **session's own connection** using a fluent [QueryBuilder] DSL.
 *
 * Connection semantics — read-your-writes within a transaction:
 * [QueryBuilder.execute] opens a *new* connection from the manager's pool, which means
 * it cannot see writes made on the current session connection that have not yet been
 * committed. This extension avoids that pitfall by building the [QueryOptions] via
 * [QueryBuilder.build] and then dispatching through
 * [ObjectManager.getObjects(ObjectConnection, MetaObject, QueryOptions)], which runs on
 * `this.connection` — the same connection that already holds the session's in-progress writes.
 *
 * @param metaObject the metamodel descriptor for the entity type to query
 * @param configure  optional DSL block applied to the [QueryBuilder] before execution
 * @return the collection of matching objects (untyped — cast elements as needed)
 */
fun OmdbSession.find(metaObject: MetaObject, configure: QueryBuilder.() -> Unit = {}): Collection<*> {
    val options = manager.query(metaObject).apply(configure).build()
    return manager.getObjects(connection, metaObject, options)
}
