package com.metaobjects.manager.db.driver;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/** Nulls sort as larger than any value in every driver: ASC last, DESC first. */
public class OrderTermNullsTest {

    private static final class Generic extends GenericSQLDriver {
        String term(String e, boolean desc) { return orderTerm(e, desc, false); }
        String distinctTerm(String e, boolean desc) { return orderTerm(e, desc, true); }
    }

    private static final class Pg extends PostgresDriver {
        String term(String e, boolean desc) { return orderTerm(e, desc, false); }
    }

    private static final class Lite extends SQLiteDriver {
        String term(String e, boolean desc) { return orderTerm(e, desc, false); }
    }

    @Test
    public void genericLeadsWithAnIsNullKey() {
        Generic d = new Generic();
        assertEquals("CASE WHEN c IS NULL THEN 1 ELSE 0 END, c", d.term("c", false));
        assertEquals("CASE WHEN c IS NULL THEN 1 ELSE 0 END DESC, c DESC", d.term("c", true));
    }

    @Test
    public void genericDistinctKeepsThePlainOrderBy() {
        Generic d = new Generic();
        assertEquals("c", d.distinctTerm("c", false));
        assertEquals("c DESC", d.distinctTerm("c", true));
    }

    @Test
    public void postgresAndSqliteUseNativeNullsClauses() {
        assertEquals("c ASC NULLS LAST", new Pg().term("c", false));
        assertEquals("c DESC NULLS FIRST", new Pg().term("c", true));
        assertEquals("c ASC NULLS LAST", new Lite().term("c", false));
        assertEquals("c DESC NULLS FIRST", new Lite().term("c", true));
    }
}
