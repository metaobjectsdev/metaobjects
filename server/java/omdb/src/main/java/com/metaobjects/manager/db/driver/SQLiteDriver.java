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
package com.metaobjects.manager.db.driver;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Locale;

import com.metaobjects.MetaDataException;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.exp.Range;

/**
 * OMDB driver for SQLite (and, since D1 is SQLite, the same dialect).
 *
 * <p>MetaObjects owns the SQLite schema ({@code meta migrate --dialect sqlite}); this driver is the
 * runtime half: CRUD, query and paging against tables the migration created. It needs only
 * {@code java.sql}, so it works with any SQLite JDBC driver; the adopter supplies one. SQLite has
 * no date, time or timestamp storage class, and {@code meta migrate} declares those columns
 * {@code TEXT}, so this driver pins the spelling rather than leaving it to the JDBC driver's
 * session settings:
 * <ul>
 *   <li>{@code field.timestamp} is ISO-8601 text, {@code yyyy-MM-dd'T'HH:mm:ss.SSS'Z'} for an
 *       instant and the same without the {@code Z} for {@code @localTime}. Read accepts that,
 *       a space instead of the {@code T}, no fraction, and an integer of epoch milliseconds.</li>
 *   <li>{@code field.date} is {@code yyyy-MM-dd} text and {@code field.time} is ISO local-time
 *       text, so neither depends on the JVM time zone.</li>
 *   <li>{@code field.uuid} is lower-case text.</li>
 *   <li>{@code field.decimal} is read from its text: an INTEGER exactly, a REAL to 15 significant digits
 *       (ADR-0019 Amendment 1, W4: {@code 0.1 + 0.2} reads {@code 0.3}), and bound as a number (an integer or a double), because a text operand never compares
 *       equal or greater to a stored number in SQLite.</li>
 *   <li>A boolean is the integer 0/1 SQLite stores it as.</li>
 * </ul>
 * Other differences from the generic driver: an {@code AUTOINCREMENT} key comes back through
 * {@code last_insert_rowid()}, identifiers are double-quoted, paging is {@code LIMIT .. OFFSET ..},
 * and there is no row-lock clause (SQLite locks the database file).
 *
 * @since 8.1.0
 */
public class SQLiteDriver extends GenericSQLDriver {

    private static final DateTimeFormatter INSTANT_TEXT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
    private static final DateTimeFormatter WALL_CLOCK_TEXT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS", Locale.ROOT);

    public SQLiteDriver() {
        super();
    }

    /** The key an {@code INTEGER PRIMARY KEY AUTOINCREMENT} column just generated on this connection. */
    @Override
    protected String getLastAutoId(Connection conn, ColumnDef col) throws SQLException {
        try (Statement s = conn.createStatement();
             ResultSet rs = s.executeQuery("SELECT last_insert_rowid()")) {
            if (!rs.next()) {
                throw new SQLException("Unable to get last id for column [" + col + "], no result in result set");
            }
            String id = rs.getString(1);
            if (id == null || "0".equals(id)) {
                throw new SQLException("last_insert_rowid() returned no key for column [" + col + "]");
            }
            return id;
        }
    }

    @Override
    protected String quoteIdent(String name) {
        if (name.indexOf('"') >= 0) throw new IllegalArgumentException("unsafe identifier: " + name);
        return "\"" + name + "\"";
    }

    @Override
    protected boolean supportsRangeInQuery() {
        return true;
    }

    /** {@code LIMIT n [OFFSET m]}; SQLite requires LIMIT whenever OFFSET is present. */
    @Override
    public String getRangeString(Range range) {
        StringBuilder b = new StringBuilder("LIMIT ").append((range.getEnd() - range.getStart()) + 1);
        if (range.getStart() > 1) b.append(" OFFSET ").append(range.getStart() - 1);
        return b.toString();
    }

    /** SQLite has no row locks: a write locks the database, so the clause is empty. */
    @Override
    public String getLockString() throws MetaDataException {
        return "";
    }

    @Override
    public String getDateFormat() {
        return "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";
    }

    @Override
    protected void setStatementValue(PreparedStatement s, MetaField f, int index, Object value) throws SQLException {
        if (f instanceof TimestampField) {
            if (value == null) s.setNull(index, Types.VARCHAR);
            else s.setString(index, timestampText(f, value));
            return;
        }
        if (f instanceof DateField) {
            if (value == null) s.setNull(index, Types.VARCHAR);
            else s.setString(index, dateText(value));
            return;
        }
        if (f instanceof DecimalField) {
            // sqlite-jdbc binds a BigDecimal as text, and SQLite orders every number before any
            // text, so `realColumn > '0'` is false for every row. Bind a number: an integral
            // value as an integer, anything else as the double SQLite stores a REAL as anyway.
            if (value == null) {
                s.setNull(index, Types.NUMERIC);
            } else {
                java.math.BigDecimal d = value instanceof java.math.BigDecimal bd ? bd : new java.math.BigDecimal(value.toString());
                if (d.signum() == 0 || d.stripTrailingZeros().scale() <= 0 && d.precision() - d.scale() <= 18) {
                    s.setLong(index, d.longValueExact());
                } else {
                    s.setDouble(index, d.doubleValue());
                }
            }
            return;
        }
        if (f instanceof TimeField) {
            if (value == null) s.setNull(index, Types.VARCHAR);
            else s.setString(index, value instanceof LocalTime lt ? lt.toString() : LocalTime.parse(value.toString()).toString());
            return;
        }
        if (isUuidColumn(f) && !isArrayField(f)) {
            if (value == null) s.setNull(index, Types.VARCHAR);
            else s.setString(index, value.toString().toLowerCase(Locale.ROOT));
            return;
        }
        super.setStatementValue(s, f, index, value);
    }

    @Override
    protected void parseField(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
        if (f instanceof TimestampField) {
            String text = rs.getString(j);
            f.setDate(o, text == null ? null : Timestamp.from(parseInstant(text)));
            return;
        }
        if (f instanceof DateField) {
            String text = rs.getString(j);
            f.setDate(o, text == null ? null
                : new java.util.Date(parseDate(text).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()));
            return;
        }
        if (f instanceof TimeField) {
            String text = rs.getString(j);
            f.setObject(o, text == null ? null : LocalTime.parse(text));
            return;
        }
        if (f instanceof DecimalField) {
            // sqlite-jdbc's getBigDecimal skips the null bookkeeping wasNull() relies on, and a
            // NUMERIC column may hold an integer, a real or text: read the text, which is exact.
            String text = rs.getString(j);
            f.setObject(o, text == null ? null : decimalFromStoredText(text.trim()));
            return;
        }
        super.parseField(o, f, rs, j);
    }

    /** The significant digits SQLite keeps of a stored REAL (ADR-0019 Amendment 1, W4). */
    private static final int SQLITE_SIGNIFICANT_DIGITS = 15;

    /**
     * ADR-0019 Amendment 1, W4: SQLite has no decimal type, and a NUMERIC column holds an INTEGER
     * (exact) or a REAL (a double). A REAL is read as its value to 15 significant digits, SQLite's
     * own text precision, so {@code 0.1 + 0.2} reads {@code 0.3} and not
     * {@code 0.30000000000000004}. An integer-looking value is exact.
     */
    static java.math.BigDecimal decimalFromStoredText(String text) {
        boolean integral = text.indexOf('.') < 0 && text.indexOf('e') < 0 && text.indexOf('E') < 0;
        if (integral) return new java.math.BigDecimal(text);
        double d;
        try {
            d = Double.parseDouble(text);
        } catch (NumberFormatException notANumber) {
            return new java.math.BigDecimal(text);   // text SQLite could not convert: say so
        }
        if (Double.isNaN(d) || Double.isInfinite(d)) return new java.math.BigDecimal(text);
        if (d == 0d) return java.math.BigDecimal.ZERO;
        java.math.BigDecimal rounded = new java.math.BigDecimal(d)
            .round(new java.math.MathContext(SQLITE_SIGNIFICANT_DIGITS, java.math.RoundingMode.HALF_EVEN));
        return rounded.signum() == 0 ? java.math.BigDecimal.ZERO : rounded.stripTrailingZeros();
    }

    private static boolean isArrayField(MetaField f) {
        return f.isArrayType();
    }

    private static boolean isLocalTime(MetaField f) {
        try {
            return f.hasMetaAttr(CoreDBMetaDataProvider.LOCAL_TIME)
                && Boolean.parseBoolean(String.valueOf(f.getMetaAttr(CoreDBMetaDataProvider.LOCAL_TIME).getValue()).trim());
        } catch (Exception e) {
            return false;
        }
    }

    private static String timestampText(MetaField f, Object value) {
        Instant at;
        if (value instanceof LocalDateTime ldt) at = ldt.toInstant(ZoneOffset.UTC);
        else if (value instanceof java.util.Date d) at = Instant.ofEpochMilli(d.getTime());
        else if (value instanceof java.time.OffsetDateTime odt) at = odt.toInstant();
        else if (value instanceof Instant i) at = i;
        else at = Instant.ofEpochMilli(Long.parseLong(value.toString()));
        return isLocalTime(f)
            ? WALL_CLOCK_TEXT.format(at.atOffset(ZoneOffset.UTC))
            : INSTANT_TEXT.format(at.atOffset(ZoneOffset.UTC));
    }

    private static String dateText(Object value) {
        if (value instanceof LocalDate ld) return ld.toString();
        if (value instanceof java.util.Date d) {
            return Instant.ofEpochMilli(d.getTime()).atZone(ZoneOffset.UTC).toLocalDate().toString();
        }
        String text = value.toString();
        try {
            return parseDate(text).toString();
        } catch (DateTimeParseException e) {
            return Instant.ofEpochMilli(Long.parseLong(text)).atZone(ZoneOffset.UTC).toLocalDate().toString();
        }
    }

    private static LocalDate parseDate(String text) {
        String t = text.trim();
        return LocalDate.parse(t.length() > 10 ? t.substring(0, 10) : t);
    }

    /** Reads the spellings a SQLite TEXT or INTEGER timestamp column holds; no zone means UTC. */
    static Instant parseInstant(String text) {
        String t = text.trim();
        if (t.matches("-?\\d+")) return Instant.ofEpochMilli(Long.parseLong(t));
        String iso = t.indexOf('T') < 0 && t.length() > 10 ? t.substring(0, 10) + "T" + t.substring(11) : t;
        if (iso.endsWith("Z") || iso.matches(".*[+-]\\d{2}:\\d{2}$")) {
            return java.time.OffsetDateTime.parse(iso).toInstant();
        }
        return LocalDateTime.parse(iso).toInstant(ZoneOffset.UTC);
    }

    @Override
    public String toString() {
        return "SQLite Database Driver";
    }

    /** Native null placement: nulls are larger than any value (ASC last, DESC first). */
    @Override
    protected String orderTerm(String expr, boolean desc, boolean distinct) {
        return expr + (desc ? " DESC NULLS FIRST" : " ASC NULLS LAST");
    }
}
