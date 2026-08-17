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
package com.metaobjects.manager.db.test;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Explicit, literal Derby DDL for the {@code codectest::Sample} fixture
 * ({@code meta.codec.json} → table {@code CODEC_SAMPLE}).
 *
 * <p>Schema is external/explicit (ADR-0015): OMDB is pure data-access and no
 * longer auto-creates tables from metadata. The OMDB tests that exercise the
 * codec fixture (bulk-create, jdbc-codec round-trip, select-assembly) bootstrap
 * their schema with this verbatim {@code CREATE TABLE} instead of the removed
 * runtime auto-create path. Column types mirror what the deleted Derby
 * createTable used to emit for each {@code java.sql.Types} mapping (long→BIGINT,
 * int→INTEGER, boolean→BOOLEAN, double→DOUBLE, float→REAL, decimal→DECIMAL,
 * date→DATE, timestamp→TIMESTAMP, time→TIME), with the {@code id} primary key as a
 * GENERATED-ALWAYS identity to
 * mirror the {@code @generation:"increment"} identity the metadata declares.</p>
 */
public final class CodecSchema {

    private CodecSchema() {}

    /** Literal Derby DDL for the CODEC_SAMPLE table. */
    public static final String CREATE_CODEC_SAMPLE =
        "CREATE TABLE CODEC_SAMPLE (\n"
            + "  id BIGINT GENERATED ALWAYS AS IDENTITY CONSTRAINT CODEC_SAMPLE_id_PK PRIMARY KEY,\n"
            + "  count INTEGER,\n"
            + "  bignum BIGINT,\n"
            + "  active BOOLEAN,\n"
            + "  ratio DOUBLE,\n"
            + "  label VARCHAR(100),\n"
            + "  rate REAL,\n"
            + "  amount DECIMAL(18,2),\n"
            + "  createdAt DATE,\n"
            + "  startTime TIME,\n"
            + "  tsVal TIMESTAMP,\n"
            + "  moneyVal BIGINT,\n"
            + "  status VARCHAR(20),\n"
            // int-backed field.enum (@intValueMap): the member symbol persists as
            // its declared INTEGER, so this column's type differs from `status`
            // above even though both are field.enum.
            + "  priority INTEGER\n"
            + ")";

    /** Executes the CODEC_SAMPLE DDL on a fresh connection from {@code connector}. */
    public static void create(ConnectionSupplier connector) throws SQLException {
        try (Connection c = connector.get();
             Statement s = c.createStatement()) {
            s.execute(CREATE_CODEC_SAMPLE);
        }
    }

    /** A {@code () -> Connection} that may throw {@link SQLException}. */
    @FunctionalInterface
    public interface ConnectionSupplier {
        Connection get() throws SQLException;
    }
}
