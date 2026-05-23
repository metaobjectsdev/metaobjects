package com.metaobjects.manager.db.migrate;

import java.util.List;

/** Computes each Change's status against AllowOptions (port of migrate-ts applyStatus). */
public final class ChangeStatusRules {
    private ChangeStatusRules() {}

    /** Replaces each change in-place with a status-stamped copy. */
    public static void applyStatus(List<Change> changes, AllowOptions allow) {
        for (int i = 0; i < changes.size(); i++) {
            Change c = changes.get(i);
            String reason = blockedReasonFor(c, allow);
            changes.set(i, c.withStatus(reason == null
                ? Change.ChangeStatus.ALLOWED : Change.ChangeStatus.blocked(reason)));
        }
    }

    private static String blockedReasonFor(Change c, AllowOptions allow) {
        if (c instanceof Change.DropColumn) {
            return allow.dropColumn() ? null : "destructive: drop-column not allowed (pass allow.dropColumn)";
        }
        if (c instanceof Change.DropTable) {
            return allow.dropTable() ? null : "destructive: drop-table not allowed (pass allow.dropTable)";
        }
        if (c instanceof Change.DropIndex) {
            return allow.dropIndex() ? null : "destructive: drop-index not allowed (pass allow.dropIndex)";
        }
        if (c instanceof Change.DropFk) {
            return allow.dropFk() ? null : "destructive: drop-fk not allowed (pass allow.dropFk)";
        }
        if (c instanceof Change.ChangeColumnType ct) {
            if (SqlType.isWidening(ct.from(), ct.to())) return null;       // widening always allowed
            return allow.typeChange() ? null : "lossy type change (pass allow.typeChange)";
        }
        return null; // create-table/add-column/rename-*/add-index/add-fk/create-view: always allowed
    }
}
