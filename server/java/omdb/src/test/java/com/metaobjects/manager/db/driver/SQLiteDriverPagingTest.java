package com.metaobjects.manager.db.driver;

import com.metaobjects.manager.exp.Range;
import org.junit.Test;

import java.time.Instant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

/** SQLiteDriver's paging clause, identifier quoting and timestamp text, with no database. */
public class SQLiteDriverPagingTest {

    /** Exposes the protected identifier hook. */
    private static final class TestDriver extends SQLiteDriver {
        String quote(String n) { return quoteIdent(n); }
    }

    private final TestDriver driver = new TestDriver();

    @Test
    public void firstPageIsLimitOnly() {
        assertEquals("LIMIT 25", driver.getRangeString(new Range(1, 25)));
    }

    @Test
    public void laterPageHasLimitBeforeOffset() {
        assertEquals("LIMIT 10 OFFSET 10", driver.getRangeString(new Range(11, 20)));
    }

    @Test
    public void rangeNeedsNoOrderByAndLockIsEmpty() throws Exception {
        assertEquals("", driver.getLockString());
    }

    @Test
    public void identifiersAreDoubleQuoted() {
        assertEquals("\"rank\"", driver.quote("rank"));
        assertThrows(IllegalArgumentException.class, () -> driver.quote("a\"b"));
    }

    @Test
    public void timestampTextSpellingsParseToTheSameInstant() {
        Instant expected = Instant.parse("2026-03-04T05:06:07.250Z");
        assertEquals(expected, SQLiteDriver.parseInstant("2026-03-04T05:06:07.250Z"));
        assertEquals(expected, SQLiteDriver.parseInstant("2026-03-04 05:06:07.250"));
        assertEquals(expected, SQLiteDriver.parseInstant("2026-03-04T05:06:07.250+00:00"));
        assertEquals(expected, SQLiteDriver.parseInstant(Long.toString(expected.toEpochMilli())));
    }
}
