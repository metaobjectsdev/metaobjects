/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
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
import java.time.LocalDateTime;
import java.time.ZoneOffset;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.exp.Range;

/**
 * OMDB driver for MySQL 8.
 *
 * <p>MetaObjects does not own a MySQL schema: {@code meta migrate} targets Postgres, SQLite and
 * D1 only, so on MySQL the adopter writes the DDL. This driver is the runtime half: CRUD, query,
 * paging and locking against tables the adopter created. What differs from the generic driver:
 * <ul>
 *   <li>{@code @generation: increment} keys come back through {@code LAST_INSERT_ID()}
 *       (an {@code AUTO_INCREMENT} column).</li>
 *   <li>Identifiers are backtick-quoted, so a column named after a reserved word
 *       ({@code rank}, {@code order}) works.</li>
 *   <li>{@code field.timestamp} is stored in a {@code DATETIME} as the UTC wall clock of the
 *       instant (MySQL has no offset-carrying type Connector/J accepts), independent of the JVM
 *       and session time zones.</li>
 *   <li>{@code field.uuid} is stored as text ({@code CHAR(36)}); MySQL has no uuid type.</li>
 * </ul>
 * The integration test {@code MySqlObjectManagerTest} runs all of this against a real server.
 *
 * @author Doug Mealing
 * @since 5.1.0
 */
public class MySQLDriver extends GenericSQLDriver {

    private static final Logger log = LoggerFactory.getLogger(MySQLDriver.class);

    public MySQLDriver() {
        super();
    }

    /**
     * Gets the next sequence for MySQL using LAST_INSERT_ID() trick
     */
    @Override
    protected String getNextAutoId(Connection conn, ColumnDef col) throws SQLException {
        if (col.getSequence() == null) {
            throw new MetaDataException("Column definition [" + col + "] has no sequence defined");
        }
        
        String seqTable = getProperName(col.getSequence().getNameDef());
        
        try {
            // Update and get next value atomically using LAST_INSERT_ID
            String updateQuery = "UPDATE " + seqTable + " SET current_value = LAST_INSERT_ID(current_value + 1)";
            
            try (Statement s = conn.createStatement()) {
                s.execute(updateQuery);
            }
            
            // Get the generated value
            String selectQuery = "SELECT LAST_INSERT_ID()";
            
            try (Statement s = conn.createStatement();
                 ResultSet rs = s.executeQuery(selectQuery)) {
                
                if (!rs.next()) {
                    throw new SQLException("Unable to get next id for column [" + col + "], no result in result set");
                }
                
                String id = rs.getString(1);
                
                if (log.isDebugEnabled()) {
                    log.debug("Retrieved id ({}) from MySQL sequence [{}]", id, seqTable);
                }
                
                if (id == null) {
                    throw new SQLException("A null sequence value was returned from MySQL");
                }
                
                return id;
            }
            
        } catch (SQLException e) {
            log.error("Unable to get next id for column [{}]: {}", col, e.getMessage(), e);
            throw new SQLException("Unable to get next id for column [" + col + "]: " + e.getMessage(), e);
        }
    }

    /**
     * The key an {@code AUTO_INCREMENT} column just generated. {@code LAST_INSERT_ID()} is
     * per-connection, and the INSERT ran on this connection immediately before, so the value is
     * unambiguous under concurrency.
     */
    @Override
    protected String getLastAutoId(Connection conn, ColumnDef col) throws SQLException {
        try (Statement s = conn.createStatement();
             ResultSet rs = s.executeQuery("SELECT LAST_INSERT_ID()")) {
            if (!rs.next()) {
                throw new SQLException("Unable to get last id for column [" + col + "], no result in result set");
            }
            String id = rs.getString(1);
            if (id == null || "0".equals(id)) {
                throw new SQLException("LAST_INSERT_ID() returned no key for column [" + col
                    + "]; is the column AUTO_INCREMENT?");
            }
            return id;
        }
    }

    /** Backtick quoting, so reserved words and mixed-case names are safe as identifiers. */
    @Override
    protected String quoteIdent(String name) {
        if (name.indexOf('`') >= 0) throw new IllegalArgumentException("unsafe identifier: " + name);
        return "`" + name + "`";
    }

    /**
     * Timestamp and uuid binds that Connector/J accepts. The shared codecs bind a timestamp as
     * {@code TIMESTAMP_WITH_TIMEZONE} and a uuid as {@code Types.OTHER}; Connector/J rejects
     * both ("Unsupported SQL type").
     */
    @Override
    protected void setStatementValue(PreparedStatement s, MetaField f, int index, Object value) throws SQLException {
        if (f instanceof TimestampField) {
            if (value == null) s.setNull(index, Types.TIMESTAMP);
            else s.setObject(index, toUtcWallClock(value));
            return;
        }
        if (isUuidColumn(f)) {
            if (value == null) s.setNull(index, Types.CHAR);
            else s.setString(index, value.toString().toLowerCase(java.util.Locale.ROOT));
            return;
        }
        super.setStatementValue(s, f, index, value);
    }

    /** Reads a {@code DATETIME} back as the UTC wall clock it was written as. */
    @Override
    protected void parseField(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
        if (f instanceof TimestampField) {
            LocalDateTime wall = rs.getObject(j, LocalDateTime.class);
            f.setDate(o, wall == null ? null : Timestamp.from(wall.toInstant(ZoneOffset.UTC)));
            return;
        }
        super.parseField(o, f, rs, j);
    }

    // The field value is an instant (java.util.Date, including java.sql.Timestamp) or already a
    // wall clock (LocalDateTime, taken as UTC — the same reading the shared codec gives it).
    private static LocalDateTime toUtcWallClock(Object value) {
        if (value instanceof LocalDateTime ldt) return ldt;
        long millis = (value instanceof java.util.Date d) ? d.getTime() : Long.parseLong(value.toString());
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), ZoneOffset.UTC);
    }

    /**
     * MySQL supports LIMIT for range queries
     */
    @Override
    protected boolean supportsRangeInQuery() {
        return true;
    }
    
    /**
     * MySQL LIMIT syntax
     */
    @Override
    public String getRangeString(Range range) {
        if (range.getStart() <= 1) {
            return "LIMIT " + range.getEnd();
        } else {
            return "LIMIT " + (range.getStart() - 1) + ", " + (range.getEnd() - range.getStart() + 1);
        }
    }

    /**
     * MySQL row locking syntax
     */
    @Override
    public String getLockString() throws MetaDataException {
        return "FOR UPDATE";
    }
    
    /**
     * MySQL date format
     */
    @Override
    public String getDateFormat() {
        return "yyyy-MM-dd HH:mm:ss";
    }

    @Override
    public String toString() {
        return "MySQL Database Driver (Enhanced for MySQL 8.0+)";
    }
}