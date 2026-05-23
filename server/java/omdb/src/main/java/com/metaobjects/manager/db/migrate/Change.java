package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

/**
 * One schema-converging operation (port of migrate-ts Change union). Every change carries a
 * ChangeStatus (set by ChangeStatusRules.applyStatus). v1 produces a subset; the rest are
 * declared for cross-language shape parity (see plan scope). schema == null => dialect default.
 */
public sealed interface Change {
    String kind();
    ChangeStatus status();
    Change withStatus(ChangeStatus s);

    /** Stable order key — renames first, then create/alter, then destructive (deterministic emit). */
    String sortKey();

    // --- produced in v1 ---
    record CreateTable(TableDescriptor table, ChangeStatus status) implements Change {
        public CreateTable(TableDescriptor t) { this(t, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.CREATE_TABLE; }
        public Change withStatus(ChangeStatus s) { return new CreateTable(table, s); }
        public String sortKey() { return "1:" + table.name() + ":"; }
    }
    record AddColumn(String table, String schema, ColumnDescriptor column, ChangeStatus status) implements Change {
        public AddColumn(String t, String sc, ColumnDescriptor c) { this(t, sc, c, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.ADD_COLUMN; }
        public Change withStatus(ChangeStatus s) { return new AddColumn(table, schema, column, s); }
        public String sortKey() { return "2:" + table + ":" + column.name(); }
    }
    record ChangeColumnType(String table, String schema, String column, SqlType from, SqlType to,
                            ChangeStatus status) implements Change {
        public ChangeColumnType(String t, String sc, String col, SqlType f, SqlType to) { this(t, sc, col, f, to, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.CHANGE_COLUMN_TYPE; }
        public Change withStatus(ChangeStatus s) { return new ChangeColumnType(table, schema, column, from, to, s); }
        public String sortKey() { return "3:" + table + ":" + column; }
    }
    record RenameTable(String from, String to, String schema, ChangeStatus status) implements Change {
        public RenameTable(String f, String t, String sc) { this(f, t, sc, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.RENAME_TABLE; }
        public Change withStatus(ChangeStatus s) { return new RenameTable(from, to, schema, s); }
        public String sortKey() { return "0:" + to + ":"; }
    }
    record RenameColumn(String table, String schema, String from, String to, ChangeStatus status) implements Change {
        public RenameColumn(String t, String sc, String f, String to) { this(t, sc, f, to, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.RENAME_COLUMN; }
        public Change withStatus(ChangeStatus s) { return new RenameColumn(table, schema, from, to, s); }
        public String sortKey() { return "0:" + table + ":" + to; }
    }
    record AddIndex(String table, String schema, IndexDescriptor index, ChangeStatus status) implements Change {
        public AddIndex(String t, String sc, IndexDescriptor i) { this(t, sc, i, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.ADD_INDEX; }
        public Change withStatus(ChangeStatus s) { return new AddIndex(table, schema, index, s); }
        public String sortKey() { return "4:" + table + ":" + index.name(); }
    }
    record DropIndex(String table, String schema, String index, ChangeStatus status) implements Change {
        public DropIndex(String t, String sc, String i) { this(t, sc, i, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_INDEX; }
        public Change withStatus(ChangeStatus s) { return new DropIndex(table, schema, index, s); }
        public String sortKey() { return "4:" + table + ":" + index; }
    }
    record AddFk(String table, String schema, FkDescriptor fk, ChangeStatus status) implements Change {
        public AddFk(String t, String sc, FkDescriptor f) { this(t, sc, f, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.ADD_FK; }
        public Change withStatus(ChangeStatus s) { return new AddFk(table, schema, fk, s); }
        public String sortKey() { return "5:" + table + ":" + fk.name(); }
    }
    record DropFk(String table, String schema, String fk, ChangeStatus status) implements Change {
        public DropFk(String t, String sc, String f) { this(t, sc, f, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_FK; }
        public Change withStatus(ChangeStatus s) { return new DropFk(table, schema, fk, s); }
        public String sortKey() { return "5:" + table + ":" + fk; }
    }
    record DropColumn(String table, String schema, String column, ChangeStatus status) implements Change {
        public DropColumn(String t, String sc, String col) { this(t, sc, col, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_COLUMN; }
        public Change withStatus(ChangeStatus s) { return new DropColumn(table, schema, column, s); }
        public String sortKey() { return "8:" + table + ":" + column; }
    }
    record DropTable(String table, String schema, ChangeStatus status) implements Change {
        public DropTable(String t, String sc) { this(t, sc, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_TABLE; }
        public Change withStatus(ChangeStatus s) { return new DropTable(table, schema, s); }
        public String sortKey() { return "9:" + table + ":"; }
    }
    record CreateView(ViewDescriptor view, ChangeStatus status) implements Change {
        public CreateView(ViewDescriptor v) { this(v, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.CREATE_VIEW; }
        public Change withStatus(ChangeStatus s) { return new CreateView(view, s); }
        public String sortKey() { return "6:" + view.name() + ":"; }
    }

    /** Named constants for change kinds (cross-language vocabulary; never inline these strings). */
    final class ChangeKind {
        private ChangeKind() {}
        public static final String CREATE_TABLE       = "create-table";
        public static final String DROP_TABLE         = "drop-table";
        public static final String RENAME_TABLE       = "rename-table";
        public static final String ADD_COLUMN         = "add-column";
        public static final String DROP_COLUMN        = "drop-column";
        public static final String RENAME_COLUMN      = "rename-column";
        public static final String CHANGE_COLUMN_TYPE = "change-column-type";
        public static final String ADD_INDEX          = "add-index";
        public static final String DROP_INDEX         = "drop-index";
        public static final String ADD_FK             = "add-fk";
        public static final String DROP_FK            = "drop-fk";
        public static final String CREATE_VIEW        = "create-view";
        // declared for parity, not produced in v1: change-column-nullable, change-column-default,
        // drop-view, replace-view
    }

    /** allowed | blocked (+ reason). Port of migrate-ts ChangeStatus. */
    record ChangeStatus(String state, String blockedReason) {
        public static final String STATE_BLOCKED = "blocked";
        public static final ChangeStatus ALLOWED = new ChangeStatus("allowed", null);
        public static ChangeStatus blocked(String reason) { return new ChangeStatus(STATE_BLOCKED, reason); }

        /** True when this change is blocked (destructive/lossy and not explicitly allowed). */
        public boolean isBlocked() { return STATE_BLOCKED.equals(state); }
    }
}
