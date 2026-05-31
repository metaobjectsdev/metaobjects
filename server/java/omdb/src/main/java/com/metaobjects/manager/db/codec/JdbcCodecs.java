/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * FR-003 Plan 4 (Debt 1) — JDBC codec registry. Replaces the if/else type
 * ladders in ObjectManagerDB.parseField and GenericSQLDriver.setStatementValue
 * with explicit per-subtype codecs (ADR-0002 Open-Closed).
 *
 * Each nested codec is a verbatim transcription of the original ladder branch.
 * Extending OMDB to a new field subtype is one register() call.
 *
 * Pattern reference: MyBatis TypeHandlerRegistry + Jackson SimpleModule —
 * explicit static registration, no ServiceLoader (which hides registration
 * from grep + tracing). Keep all codecs in this single file so a reader sees
 * the full type-handling surface at once.
 */
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimeField;

import java.math.BigDecimal;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.LocalTime;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class JdbcCodecs {

    private static final Map<Class<? extends MetaField>, JdbcFieldCodec> BY_TYPE = new ConcurrentHashMap<>();
    private static final JdbcFieldCodec DEFAULT = new ObjectCodec();

    private JdbcCodecs() {}

    /** Register a codec for a field subtype. A new field type adds one line here. */
    public static void register(Class<? extends MetaField> type, JdbcFieldCodec codec) {
        BY_TYPE.put(type, codec);
    }

    public static JdbcFieldCodec defaultCodec() {
        return DEFAULT;
    }

    public static JdbcFieldCodec forField(MetaField f) {
        return BY_TYPE.getOrDefault(f.getClass(), DEFAULT);
    }

    static {
        register(BooleanField.class, new BooleanCodec());
        register(DecimalField.class, new DecimalCodec());
        register(IntegerField.class, new IntegerCodec());
        register(DateField.class, new DateCodec());
        register(TimeField.class, new TimeCodec());
        register(LongField.class, new LongCodec());
        register(FloatField.class, new FloatCodec());
        register(DoubleField.class, new DoubleCodec());
        register(StringField.class, new StringCodec());
        register(ObjectField.class, DEFAULT);  // identity with the fallback codec
    }

    // ── codecs (each body = verbatim transcription of its prior ladder branch) ──

    static final class BooleanCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            boolean bv = rs.getBoolean(j);
            f.setBoolean(o, rs.wasNull() ? null : bv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.BIT);
            else if (v instanceof Boolean) s.setBoolean(j, (Boolean) v);
            else s.setBoolean(j, Boolean.valueOf(v.toString()));
        }
    }

    static final class DecimalCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            BigDecimal dv = rs.getBigDecimal(j);
            f.setObject(o, rs.wasNull() ? null : dv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.DECIMAL);
            else if (v instanceof BigDecimal) s.setBigDecimal(j, (BigDecimal) v);
            else s.setBigDecimal(j, new BigDecimal(v.toString()));
        }
    }

    static final class IntegerCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            int iv = rs.getInt(j);
            f.setInt(o, rs.wasNull() ? null : iv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.INTEGER);
            else if (v instanceof Integer) s.setInt(j, (Integer) v);
            else s.setInt(j, Integer.valueOf(v.toString()));
        }
    }

    /** Date is stored as a timestamp at the SQL layer (legacy OMDB convention). */
    static final class DateCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            Timestamp tv = rs.getTimestamp(j);
            f.setDate(o, rs.wasNull() ? null : new java.util.Date(tv.getTime()));
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.TIMESTAMP);
            else if (v instanceof java.util.Date) s.setTimestamp(j, new Timestamp(((java.util.Date) v).getTime()));
            else s.setTimestamp(j, new Timestamp(Long.valueOf(v.toString())));
        }
    }

    /**
     * TimeField read mirrors the write side (LocalTime ⇄ java.sql.Time): read
     * the column as a {@link java.sql.Time} and convert to {@link LocalTime},
     * the canonical Java representation for {@code field.time}. The previous
     * stub fell through to {@code getObject} (driver-dependent type) which had
     * drifted from the write codec.
     *
     * <p>Declares {@link #sqlType()} = {@code Types.TIME} and {@link #sqlLength()} = 0
     * so that {@link com.metaobjects.manager.db.SimpleMappingHandlerDB} can
     * consult the codec instead of carrying an {@code instanceof TimeField} guard.
     */
    static final class TimeCodec implements JdbcFieldCodec {
        @Override public int sqlType() { return Types.TIME; }
        @Override public int sqlLength() { return 0; }

        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            // Prefer reading TIME as a LocalTime via JDBC 4.2 getObject: java.sql.Time
            // has no sub-second component, so going through it silently truncates the
            // fractional seconds a TIME column carries (e.g. 14:30:00.123 → 14:30:00).
            // pgjdbc honours getObject(LocalTime.class) and preserves the fraction;
            // drivers that reject the conversion (e.g. Derby) fall back to the
            // java.sql.Time path — those backends are second-resolution anyway.
            LocalTime tv;
            try {
                tv = rs.getObject(j, LocalTime.class);
            } catch (SQLException ex) {
                java.sql.Time t = rs.getTime(j);
                tv = t == null ? null : t.toLocalTime();
            }
            f.setObject(o, rs.wasNull() ? null : tv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.TIME);
            else if (v instanceof LocalTime) s.setTime(j, java.sql.Time.valueOf((LocalTime) v));
            else {
                try {
                    s.setTime(j, java.sql.Time.valueOf(LocalTime.parse(v.toString())));
                } catch (DateTimeParseException e) {
                    throw new SQLException("Invalid time format: " + v, e);
                }
            }
        }
    }

    static final class LongCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            long lv = rs.getLong(j);
            f.setLong(o, rs.wasNull() ? null : lv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.BIGINT);
            else if (v instanceof Long) s.setLong(j, (Long) v);
            else s.setLong(j, Long.valueOf(v.toString()));
        }
    }

    static final class FloatCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            float fv = rs.getFloat(j);
            f.setFloat(o, rs.wasNull() ? null : fv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.FLOAT);
            else if (v instanceof Float) s.setFloat(j, (Float) v);
            else s.setFloat(j, Float.valueOf(v.toString()));
        }
    }

    static final class DoubleCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            double dv = rs.getDouble(j);
            f.setDouble(o, rs.wasNull() ? null : dv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.DOUBLE);
            else if (v instanceof Double) s.setDouble(j, (Double) v);
            else s.setDouble(j, Double.valueOf(v.toString()));
        }
    }

    static final class StringCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            f.setString(o, rs.getString(j));
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.VARCHAR);
            else s.setString(j, v.toString());
        }
    }

    /** Default fallback: pass-through via JDBC's getObject/setObject. */
    static final class ObjectCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            f.setObject(o, rs.getObject(j));
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            s.setObject(j, v);
        }
    }
}
