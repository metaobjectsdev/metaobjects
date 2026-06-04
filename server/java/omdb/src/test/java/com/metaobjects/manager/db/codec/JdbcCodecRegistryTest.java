/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * FR-003 Plan 4 (Debt 1) — codec registry contract test. Doesn't exercise JDBC
 * IO — that's already covered by the omdb round-trip suite (Derby + Postgres).
 */
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.field.UuidField;
import org.junit.Test;

import java.sql.Types;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;

public class JdbcCodecRegistryTest {

    @Test
    public void builtInTypesResolve() {
        assertNotNull("StringField must resolve", JdbcCodecs.forField(new StringField("name")));
        assertNotNull("BooleanField must resolve", JdbcCodecs.forField(new BooleanField("flag")));
    }

    /**
     * SP-H Unit 5 — every persistable subtype must resolve to a DEDICATED codec, never
     * the generic {@link JdbcCodecs#defaultCodec()} fallback. Before this unit,
     * {@code field.timestamp} / {@code field.currency} / {@code field.enum} /
     * {@code field.uuid} all silently rode the default {@code ObjectCodec} (getObject /
     * setObject), which is the write hazard the round-trip gate now covers (pgjdbc rejects
     * {@code setObject(java.util.Date)} for timestamp).
     */
    @Test
    public void sphSubtypesResolveToDedicatedCodecs() {
        JdbcFieldCodec def = JdbcCodecs.defaultCodec();
        assertNotSame("TimestampField must have a dedicated codec",
                def, JdbcCodecs.forField(new TimestampField("ts")));
        assertNotSame("CurrencyField must have a dedicated codec",
                def, JdbcCodecs.forField(new CurrencyField("money")));
        assertNotSame("EnumField must have a dedicated codec",
                def, JdbcCodecs.forField(new EnumField("status")));
        assertNotSame("UuidField must have a dedicated codec",
                def, JdbcCodecs.forField(new UuidField("uid")));
    }

    @Test
    public void registeringANewCodecResolvesToIt() {
        // Open-Closed proof: register a fresh codec against ObjectField and
        // confirm the registry returns it. Restore the default afterward so
        // other tests are unaffected.
        JdbcFieldCodec original = JdbcCodecs.forField(new ObjectField("o"));
        JdbcFieldCodec fresh = new JdbcCodecs.ObjectCodec();
        try {
            JdbcCodecs.register(ObjectField.class, fresh);
            assertSame("newly-registered codec must resolve",
                fresh, JdbcCodecs.forField(new ObjectField("o")));
        } finally {
            JdbcCodecs.register(ObjectField.class, original);
        }
    }

    @Test
    public void distinctTypesHaveDistinctCodecs() {
        assertNotSame(JdbcCodecs.forField(new StringField("s")),
            JdbcCodecs.forField(new BooleanField("b")));
    }

    @Test
    public void registeredObjectFieldIsTheDefault() {
        assertSame("ObjectField resolves to the same instance as the default codec",
            JdbcCodecs.defaultCodec(), JdbcCodecs.forField(new ObjectField("o")));
    }

    // ── OCP: codec declares its own SQL type/length (no instanceof in SimpleMappingHandlerDB) ──

    /**
     * TimeCodec must declare {@code Types.TIME} via {@code sqlType()} so that
     * {@link com.metaobjects.manager.db.SimpleMappingHandlerDB} can consult the codec
     * instead of carrying an {@code instanceof TimeField} guard.
     */
    @Test
    public void timeCodecDeclaresItsSqlType() {
        JdbcFieldCodec codec = JdbcCodecs.forField(new TimeField("t"));
        assertEquals("TimeCodec.sqlType() must return Types.TIME",
                Types.TIME, codec.sqlType());
    }

    @Test
    public void timeCodecDeclaresZeroSqlLength() {
        JdbcFieldCodec codec = JdbcCodecs.forField(new TimeField("t"));
        assertEquals("TimeCodec.sqlLength() must return 0 (TIME columns carry no length)",
                0, codec.sqlLength());
    }

    /**
     * Non-time codecs must return the NO_SQL_TYPE sentinel so they don't
     * accidentally override the DataType-based switch in SimpleMappingHandlerDB.
     */
    @Test
    public void nonTimeCodecsReturnNoOpSentinel() {
        assertEquals("StringField codec must defer to DataType switch",
                JdbcFieldCodec.NO_SQL_TYPE, JdbcCodecs.forField(new StringField("s")).sqlType());
        assertEquals("BooleanField codec must defer to DataType switch",
                JdbcFieldCodec.NO_SQL_TYPE, JdbcCodecs.forField(new BooleanField("b")).sqlType());
        assertEquals("default ObjectCodec must defer to DataType switch",
                JdbcFieldCodec.NO_SQL_TYPE, JdbcCodecs.defaultCodec().sqlType());
    }
}
