package com.metaobjects.manager.db.migrate;

/** Explicit destructive-change opt-in (port of migrate-ts AllowOptions). */
public record AllowOptions(boolean dropColumn, boolean dropTable, boolean typeChange,
                           boolean dropIndex, boolean dropFk, boolean nullableToNotNull) {
    public AllowOptions() { this(false, false, false, false, false, false); }
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private boolean dc, dt, tc, di, df, n2n;
        public Builder dropColumn(boolean v) { dc = v; return this; }
        public Builder dropTable(boolean v) { dt = v; return this; }
        public Builder typeChange(boolean v) { tc = v; return this; }
        public Builder dropIndex(boolean v) { di = v; return this; }
        public Builder dropFk(boolean v) { df = v; return this; }
        public Builder nullableToNotNull(boolean v) { n2n = v; return this; }
        public AllowOptions build() { return new AllowOptions(dc, dt, tc, di, df, n2n); }
    }
}
