package com.metaobjects.manager.db;

import com.metaobjects.manager.db.migrate.Change;

/** Dialect render of a single Change to forward-only SQL. Implemented by drivers (Postgres+Derby in v1). */
public interface MigrationSqlRenderer {
    /** @return the SQL statement (no trailing ';'); throws UnsupportedOperationException for unported kinds/dialects. */
    String render(Change change);
}
