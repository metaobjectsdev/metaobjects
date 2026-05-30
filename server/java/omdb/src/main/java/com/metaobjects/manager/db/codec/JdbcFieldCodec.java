/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * FR-003 Plan 4 (Debt 1) — Open-Closed JDBC value dispatch (ADR-0002).
 *
 * Replaces the if/else type ladders in ObjectManagerDB.parseField and
 * GenericSQLDriver.setStatementValue with per-field-subtype dispatch.
 * JDBC stays in this `omdb` module — ResultSet/PreparedStatement never
 * leak into core field classes, which keeps the metadata core dialect-free.
 */
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.MetaField;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * Reads a column into an object's field, and writes a field value to a
 * statement parameter. Codecs are stateless singletons keyed by field
 * subtype in {@link JdbcCodecs}.
 *
 * <p>A codec may additionally declare its preferred DDL column type and length
 * via {@link #sqlType()} and {@link #sqlLength()}.  This lets
 * {@link com.metaobjects.manager.db.SimpleMappingHandlerDB} consult the
 * codec instead of carrying {@code instanceof} guards for custom field types
 * (OCP — adding a new CUSTOM field subtype is one codec registration, not a
 * code change in two places).
 */
public interface JdbcFieldCodec {

    /**
     * Sentinel returned by {@link #sqlType()} when a codec defers to the
     * {@code DataType}-based switch in {@code SimpleMappingHandlerDB}.
     */
    int NO_SQL_TYPE = Integer.MIN_VALUE;

    /** Read column {@code col} from {@code rs} into the field on {@code target}. */
    void readInto(Object target, MetaField field, ResultSet rs, int col) throws SQLException;

    /** Bind {@code value} to parameter {@code index} on {@code ps} per the field's column type. */
    void write(PreparedStatement ps, MetaField field, int index, Object value) throws SQLException;

    /**
     * The {@code java.sql.Types} code for this codec's DDL column type, or
     * {@link #NO_SQL_TYPE} to defer to the field's {@code DataType} switch.
     * Overriding is required only for CUSTOM-DataType fields (e.g. TimeField)
     * whose SQL type cannot be inferred from the standard DataType enum.
     */
    default int sqlType() { return NO_SQL_TYPE; }

    /**
     * The DDL column length for this codec's column type, or any negative value
     * (typically {@code -1}) to defer to the {@code DataType}-based default in
     * {@code SimpleMappingHandlerDB.getSQLLength} (which treats {@code length >= 0}
     * as the codec's opinion — e.g. {@code 0} for a TIME column).
     */
    default int sqlLength() { return -1; }
}
