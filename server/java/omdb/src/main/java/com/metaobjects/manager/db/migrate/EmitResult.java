package com.metaobjects.manager.db.migrate;

/**
 * Port of migrate-ts EmitResult. v1 fills {@code up} only; {@code down} is "" (declared for
 * cross-language shape parity). TS also carries {@code recreatedTables} (SQLite recreate-and-copy
 * bookkeeping) — omitted here: the v1 Java dialects (Postgres/Derby) use in-place ALTER, so there
 * is no recreate set to track.
 */
public record EmitResult(String up, String down) {}
