package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.statements.api.PreparedStatementApi
import org.jetbrains.exposed.sql.statements.jdbc.JdbcPreparedStatementImpl
import org.jetbrains.exposed.sql.vendors.currentDialect
import java.net.URI
import java.sql.ResultSet
import java.sql.Types

/**
 * Hand-written reference Exposed column types for `field.uri` / `field.inet` (ADR-0036/0037
 * Wave 3) — the test-harness analogue of the per-package `MetaInetUriColumnType.kt` the
 * [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator] emits.
 *
 * `field.uri` mirrors the generated `MetaUriColumnType` 1:1 (a `Column<java.net.URI>` over plain
 * `text`; persists/round-trips the verbatim URI string).
 *
 * `field.inet` DEVIATES from the generated `MetaInetColumnType` on the READ side ON PURPOSE.
 * The generator's column is a `Column<java.net.InetAddress>` whose `valueFromDB` resolves the
 * JDBC value to an `InetAddress` — and `InetAddress.getHostAddress()` returns the UNcompressed
 * IPv6 form (`2001:db8:0:0:0:8a2e:370:7334`). The persistence-conformance `op:roundtrip`
 * expectation is the canonical COMPRESSED form (`2001:db8::8a2e:370:7334`) — which is exactly
 * what Postgres' native `inet` wire text already is. So the reference column here is a
 * `Column<String>` over the native `inet` type that READS the driver's native inet string
 * directly via `ResultSet.getString` (compressed, bare host — NO `::text` cast, so no `/32`|`/128`
 * mask is appended) and WRITES the bare address string via the driver's `inet` coercion. This is
 * the "read the inet column as the driver's string wire value" rule from the corpus
 * (`roundtrip-all-types.yaml`): it keeps the read-back byte-identical to the cross-port wire form
 * without re-deriving the host literal from an `InetAddress`.
 */

/** Custom column type for `field.uri`: a `Column<java.net.URI>` over plain `text`. */
internal class MetaUriColumnType : ColumnType<URI>() {
    override fun sqlType(): String = currentDialect.dataTypeProvider.textType()
    override fun valueFromDB(value: Any): URI = when (value) {
        is URI -> value
        else -> URI.create(value.toString())
    }
    override fun notNullValueToDB(value: URI): Any = value.toString()
    override fun nonNullValueToString(value: URI): String = "'$value'"
}

/** Column builder for `field.uri`: a `Column<java.net.URI>` over a `text` column. */
internal fun Table.uriColumn(name: String): Column<URI> =
    registerColumn(name, MetaUriColumnType())

/**
 * Custom column type for `field.inet`: a `Column<String>` over the Postgres-native `inet` type
 * that round-trips the bare host-literal string. The READ asks the driver for the native inet
 * wire text (`ResultSet.getString`), which Postgres returns WITHOUT a CIDR mask (host address,
 * no `/32`|`/128`) and in CANONICAL COMPRESSED form for IPv6 — so the read-back matches the
 * corpus expectation without going through `InetAddress.getHostAddress()` (which would emit the
 * uncompressed IPv6). The WRITE binds the address string and lets the JDBC driver coerce it to
 * the native `inet` column.
 */
internal class MetaInetStringColumnType : ColumnType<String>() {
    override fun sqlType(): String = "inet"
    override fun valueFromDB(value: Any): String = value.toString()
    override fun notNullValueToDB(value: String): Any = value
    override fun nonNullValueToString(value: String): String = "'$value'"
    /** Read the native inet wire string (compressed IPv6, bare host — no `::text` cast). */
    override fun readObject(rs: ResultSet, index: Int): Any? = rs.getString(index)
    override fun setParameter(stmt: PreparedStatementApi, index: Int, value: Any?) {
        // Bind the bare address string via setObject(.., Types.OTHER) so the Postgres JDBC driver
        // coerces it to the native `inet` column. Exposed's plain `stmt[index] = value` binds the
        // String as VARCHAR (default stringtype), which Postgres rejects ("column is of type inet
        // but expression is of type character varying"). Reach the raw java.sql.PreparedStatement
        // and bind with Types.OTHER — the exact pattern OMDB's InetCodec uses on the JVM.
        val raw = (stmt as JdbcPreparedStatementImpl).statement
        if (value == null) raw.setNull(index, Types.OTHER)
        else raw.setObject(index, value.toString(), Types.OTHER)
    }
}

/** Column builder for `field.inet`: a `Column<String>` (native inet wire string) over an `inet` column. */
internal fun Table.inetColumn(name: String): Column<String> =
    registerColumn(name, MetaInetStringColumnType())
