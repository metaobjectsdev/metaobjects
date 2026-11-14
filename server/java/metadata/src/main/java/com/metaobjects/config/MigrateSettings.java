package com.metaobjects.config;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;

/**
 * The schema settings in the TypeScript-owned {@code migrate} block of
 * {@code .metaobjects/config.json} that a generator mapping the schema has to agree with:
 * {@code foreignKeyIndexes} (index every foreign key nothing else leads with, under
 * {@code <table>_<columns>_idx}), {@code conventions} (the schema-conventions preset, or
 * {@code null} for the default) and {@code dialect}. Read leniently: {@code meta migrate}
 * validates the block, and a value of the wrong type here reads as absent. Carried on the loaded
 * root beside the naming rules.
 */
public final class MigrateSettings {

    /** No {@code migrate} settings: no foreign-key indexes, default conventions, no dialect. */
    public static final MigrateSettings DEFAULT = new MigrateSettings(false, null, null);

    private final boolean foreignKeyIndexes;
    private final String conventions;
    private final String dialect;

    public MigrateSettings(boolean foreignKeyIndexes, String conventions, String dialect) {
        this.foreignKeyIndexes = foreignKeyIndexes;
        this.conventions = conventions;
        this.dialect = dialect;
    }

    /** {@code migrate.foreignKeyIndexes}; false when absent. */
    public boolean isForeignKeyIndexes() {
        return foreignKeyIndexes;
    }

    /** {@code migrate.conventions}, or {@code null} when absent. */
    public String getConventions() {
        return conventions;
    }

    /** {@code migrate.dialect}, or {@code null} when absent. */
    public String getDialect() {
        return dialect;
    }

    /**
     * Whether a schema mapping declares migrate's foreign-key indexes: the option is on, and
     * neither the {@code efcore} conventions (which index every foreign key with their own names)
     * nor MySQL (where InnoDB indexes each foreign key itself) already account for them.
     */
    public boolean indexesForeignKeys() {
        return foreignKeyIndexes && !"efcore".equals(conventions) && !"mysql".equalsIgnoreCase(dialect);
    }

    /** The settings for the tree {@code node} belongs to: what its root carries, else none. */
    public static MigrateSettings of(MetaData node) {
        for (MetaData n = node; n != null; n = n.getParent()) {
            if (n instanceof MetaRoot root) return root.getMigrateSettings();
        }
        return DEFAULT;
    }
}
