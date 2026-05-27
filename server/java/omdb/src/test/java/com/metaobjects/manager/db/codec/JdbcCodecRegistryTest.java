/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * FR-003 Plan 4 (Debt 1) — codec registry contract test. Doesn't exercise JDBC
 * IO — that's already covered by the omdb round-trip suite (Derby + Postgres).
 */
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import org.junit.Test;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;

public class JdbcCodecRegistryTest {

    @Test
    public void builtInTypesResolve() {
        assertNotNull("StringField must resolve", JdbcCodecs.forField(new StringField("name")));
        assertNotNull("BooleanField must resolve", JdbcCodecs.forField(new BooleanField("flag")));
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
}
