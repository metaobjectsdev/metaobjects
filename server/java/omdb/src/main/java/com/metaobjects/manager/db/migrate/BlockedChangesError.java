package com.metaobjects.manager.db.migrate;

import java.util.List;
import java.util.Map;

/** Thrown by emit/apply when blocked (destructive) changes would be written. */
public class BlockedChangesError extends RuntimeException {
    private static final Map<String, String> ENABLE_FLAG = Map.of(
        Change.ChangeKind.DROP_COLUMN,        "allow.dropColumn",
        Change.ChangeKind.DROP_TABLE,         "allow.dropTable",
        Change.ChangeKind.CHANGE_COLUMN_TYPE, "allow.typeChange",
        Change.ChangeKind.DROP_INDEX,         "allow.dropIndex",
        Change.ChangeKind.DROP_FK,            "allow.dropFk");

    private final transient List<Change> blocked;

    public BlockedChangesError(List<Change> blocked) {
        super(buildMessage(blocked));
        this.blocked = blocked;
    }
    public List<Change> getBlocked() { return blocked; }

    private static String buildMessage(List<Change> blocked) {
        StringBuilder sb = new StringBuilder(blocked.size() + " blocked change(s):");
        for (Change c : blocked) {
            String key = c.sortKey();
            String locator = key.substring(key.indexOf(':') + 1);   // drop the phase prefix -> "table:detail"
            sb.append("\n  - ").append(c.kind()).append(" on ").append(locator)
              .append(": pass ").append(ENABLE_FLAG.getOrDefault(c.kind(), "(no flag enables this)"));
        }
        return sb.toString();
    }
}
