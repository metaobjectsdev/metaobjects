package com.metaobjects.manager.db.migrate;

import java.util.HashMap;
import java.util.Map;

/** Rename hints harvested from @previousName (Java v1's rename mechanism). */
public final class RenameHints {
    private final Map<String, String> tableRenames = new HashMap<>();
    private final Map<String, Map<String, String>> columnRenames = new HashMap<>();

    public static RenameHints empty() { return new RenameHints(); }

    public void addTableRename(String currentTable, String prev) {
        tableRenames.put(currentTable.toLowerCase(), prev);
    }

    public void addColumnRename(String table, String currentCol, String prev) {
        columnRenames.computeIfAbsent(table.toLowerCase(), k -> new HashMap<>())
                     .put(currentCol.toLowerCase(), prev);
    }

    public String previousTable(String currentTable) {
        return tableRenames.get(currentTable.toLowerCase());
    }

    public String previousColumn(String table, String currentCol) {
        Map<String, String> m = columnRenames.get(table.toLowerCase());
        return m == null ? null : m.get(currentCol.toLowerCase());
    }
}
