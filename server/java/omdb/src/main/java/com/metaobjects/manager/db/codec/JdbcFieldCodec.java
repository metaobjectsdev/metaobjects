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
 */
public interface JdbcFieldCodec {

    /** Read column {@code col} from {@code rs} into the field on {@code target}. */
    void readInto(Object target, MetaField field, ResultSet rs, int col) throws SQLException;

    /** Bind {@code value} to parameter {@code index} on {@code ps} per the field's column type. */
    void write(PreparedStatement ps, MetaField field, int index, Object value) throws SQLException;
}
