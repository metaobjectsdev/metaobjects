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

import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.field.UuidField;

import java.math.BigDecimal;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.UUID;
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
        register(TimestampField.class, new TimestampCodec());
        register(CurrencyField.class, new CurrencyCodec());
        register(EnumField.class, new EnumCodec());
        register(UuidField.class, new UuidCodec());
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
            if (v == null) { s.setNull(j, Types.TIME); return; }
            LocalTime lt;
            if (v instanceof LocalTime localTime) {
                lt = localTime;
            } else {
                try {
                    lt = LocalTime.parse(v.toString());
                } catch (DateTimeParseException e) {
                    throw new SQLException("Invalid time format: " + v, e);
                }
            }
            // Bind as a LocalTime via JDBC 4.2 setObject so the fractional-second component
            // survives (java.sql.Time.valueOf TRUNCATES sub-second — e.g. 14:30:00.123 →
            // 14:30:00, the bug the SP-H roundtrip gate caught). Drivers that reject the
            // LocalTime bind (e.g. Derby) fall back to java.sql.Time — those backends are
            // second-resolution anyway, mirroring the read side.
            try {
                s.setObject(j, lt, Types.TIME);
            } catch (SQLException ex) {
                s.setTime(j, java.sql.Time.valueOf(lt));
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

    /**
     * {@code field.timestamp} ⇄ TIMESTAMP / TIMESTAMPTZ. The field's logical value is a
     * {@link java.util.Date} (TimestampField is backed by {@code DataTypes.DATE}).
     *
     * <p><b>The write hazard this codec closes.</b> Before SP-H Unit 5 TimestampField had no
     * codec and fell to the generic {@link ObjectCodec}, whose {@code setObject(java.util.Date)}
     * is rejected by pgjdbc ("Can't infer the SQL type to use for an instance of
     * java.util.Date") — the INSERT threw at runtime. We bind an explicit
     * {@link java.sql.Timestamp} (plain) or a UTC {@link OffsetDateTime} (tz-aware) instead.
     *
     * <ul>
     *   <li><b>Plain TIMESTAMP</b> (no {@code @dbColumnType}): {@code setTimestamp} /
     *       {@code getTimestamp}. The instant's wall-clock is stored verbatim; the runner
     *       pins the JVM zone to UTC so the wall clock is the UTC wall clock the corpus
     *       expects (no {@code Z} on the wire).</li>
     *   <li><b>TIMESTAMPTZ</b> ({@code @dbColumnType: timestamp_with_tz}): bind a UTC
     *       {@link OffsetDateTime} via {@code setObject(.., TIMESTAMP_WITH_TIMEZONE)} so pgjdbc
     *       targets the {@code timestamptz} column correctly (a bare {@code setTimestamp} on a
     *       tz column would be interpreted in the session zone). Read stays {@code getTimestamp}
     *       (→ java.util.Date); {@code ObjectManagerDbAdapter.coerceWireType} lifts a tz-flagged
     *       value to an {@link OffsetDateTime} so {@code Normalization} appends the {@code Z}.</li>
     * </ul>
     */
    static final class TimestampCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            // Keep the value a java.sql.Timestamp (NOT a plain java.util.Date): Normalization
            // renders a Timestamp with its wall-clock time ("...T HH:mm:ss"), whereas a plain
            // java.util.Date is the DATE-column form and renders date-only. (Timestamp IS a
            // java.util.Date, so setDate accepts it; the runtime native type stays Timestamp.)
            Timestamp tv = rs.getTimestamp(j);
            f.setDate(o, rs.wasNull() ? null : tv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            boolean tz = isTimestampTz(f);
            if (v == null) {
                s.setNull(j, tz ? Types.TIMESTAMP_WITH_TIMEZONE : Types.TIMESTAMP);
                return;
            }
            long millis = (v instanceof java.util.Date d) ? d.getTime() : Long.parseLong(v.toString());
            if (tz) {
                // tz-aware column: bind an absolute instant as a UTC OffsetDateTime so pgjdbc
                // routes it to the timestamptz column without a session-zone reinterpretation.
                OffsetDateTime odt = java.time.Instant.ofEpochMilli(millis).atOffset(ZoneOffset.UTC);
                s.setObject(j, odt, Types.TIMESTAMP_WITH_TIMEZONE);
            } else {
                s.setTimestamp(j, new Timestamp(millis));
            }
        }
    }

    /**
     * {@code field.currency} ⇄ BIGINT. Money is stored as integer minor units (the cross-port
     * wire contract — float arithmetic for money is forbidden); CurrencyField is backed by
     * {@code DataTypes.LONG}, so this is bind-as-{@code long} / read-as-{@code long}, identical
     * to {@link LongCodec} but registered explicitly so currency does not silently ride the
     * generic {@link ObjectCodec} fallback.
     */
    static final class CurrencyCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            long lv = rs.getLong(j);
            f.setLong(o, rs.wasNull() ? null : lv);
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.BIGINT);
            else if (v instanceof Long) s.setLong(j, (Long) v);
            else if (v instanceof Number n) s.setLong(j, n.longValue());
            else s.setLong(j, Long.valueOf(v.toString()));
        }
    }

    /**
     * {@code field.enum} ⇄ a text column. The enum is string-backed (its member symbol is the
     * stored value — see {@code EnumField}); EnumField is backed by {@code DataTypes.STRING}, so
     * this is bind-as-string / read-as-string, identical to {@link StringCodec} but registered
     * explicitly so enum does not ride the generic {@link ObjectCodec} fallback. The DB
     * {@code CHECK (col IN (...))} (emitted from {@code @values}) enforces membership.
     */
    static final class EnumCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            f.setString(o, rs.getString(j));
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.VARCHAR);
            else s.setString(j, v.toString());
        }
    }

    /**
     * {@code field.uuid} ⇄ a native Postgres {@code uuid} column. UuidField is backed by
     * {@code DataTypes.STRING} (the wire form is the lowercase-canonical UUID string), but a
     * native {@code uuid} column rejects a {@code setString} ("operator does not exist: uuid =
     * varchar" / type-mismatch on INSERT without {@code stringtype=unspecified}). Bind a
     * {@link java.util.UUID} via {@code setObject(.., Types.OTHER)} instead, and read back the
     * value lowercase-canonical (dialect-independent — Derby stores a CHAR(36) verbatim).
     *
     * <p>Note: for the Postgres driver the native-uuid binding is also intercepted earlier by
     * {@code GenericSQLDriver.setStatementValue}'s {@code isUuidColumn} branch (which additionally
     * covers {@code @dbColumnType: uuid} on a plain string field). This codec makes the
     * {@code field.uuid} subtype self-contained so it is correct even on a driver/path that does
     * not carry that override, and removes the silent {@link ObjectCodec} fallback.</p>
     */
    static final class UuidCodec implements JdbcFieldCodec {
        @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            String v = rs.getString(j);
            f.setString(o, (v == null || rs.wasNull()) ? null : v.toLowerCase(java.util.Locale.ROOT));
        }
        @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) {
                s.setNull(j, Types.OTHER);
            } else {
                UUID uuid = (v instanceof UUID u) ? u : UUID.fromString(v.toString());
                s.setObject(j, uuid, Types.OTHER);
            }
        }
    }

    /** True for a {@code field.timestamp} carrying {@code @dbColumnType: timestamp_with_tz}. */
    private static boolean isTimestampTz(MetaField f) {
        try {
            return f.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE)
                && CoreDBMetaDataProvider.DB_COLUMN_TYPE_TIMESTAMP_TZ.equalsIgnoreCase(
                    String.valueOf(f.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE).getValue()).trim());
        } catch (Exception e) {
            return false;
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
