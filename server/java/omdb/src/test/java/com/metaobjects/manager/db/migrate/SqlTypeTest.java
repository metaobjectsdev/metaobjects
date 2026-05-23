package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SqlType.*;

public class SqlTypeTest {
    @Test public void record_equality_is_structural_sqlTypeEquals() {
        assertEquals(new Text(120), new Text(120));
        assertNotEquals(new Text(120), new Text(80));
        assertEquals(new Int(64), new Int(64));
        assertNotEquals(new Int(32), new Int(64));
    }
    @Test public void widening_varchar_longer_is_widening() {
        assertTrue(SqlType.isWidening(new Text(120), new Text(400)));
        assertTrue(SqlType.isWidening(new Text(120), new Text((Integer) null))); // bounded -> unbounded
        assertFalse(SqlType.isWidening(new Text(400), new Text(120))); // narrowing
        assertFalse(SqlType.isWidening(new Text((Integer) null), new Text(120))); // unbounded -> bounded lossy
    }
    @Test public void widening_int_more_bits_is_widening() {
        assertTrue(SqlType.isWidening(new Int(32), new Int(64)));
        assertFalse(SqlType.isWidening(new Int(64), new Int(32)));
    }
    @Test public void cross_kind_and_identical_are_not_widening() {
        assertFalse(SqlType.isWidening(new Int(32), new Text(120))); // cross-kind: lossy
        assertFalse(SqlType.isWidening(new Text(120), new Text(120))); // identical
    }
}
