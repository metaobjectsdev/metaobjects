package com.metaobjects.manager.db.migrate;

import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.MappingHandler;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.ObjectMapping;
import com.metaobjects.manager.db.ObjectMappingDB;
import com.metaobjects.manager.db.defs.BaseDef;
import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.manager.db.defs.ViewDef;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.ColumnDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.TableDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.ViewDescriptor;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds the EXPECTED {@link SchemaSnapshot} from metadata, reusing the same
 * MappingHandler-derived TableDef/ViewDef the boot-time validator uses (no re-derivation)
 * and the mapped type carried on ColumnDef (converted to canonical SqlType via
 * {@link JdbcSqlTypes}). Also harvests {@code @previousName} into {@link RenameHints}.
 */
public final class ExpectedSchemaBuilder {

    private final ObjectManagerDB manager;
    private final MetaDataLoaderRegistry loaderRegistry;

    public ExpectedSchemaBuilder(ObjectManagerDB manager, MetaDataLoaderRegistry loaderRegistry) {
        this.manager = manager;
        this.loaderRegistry = loaderRegistry;
    }

    /**
     * Build the snapshot; fills {@code hints} as a side-effect.
     * Pass {@link RenameHints#empty()} if rename tracking is not needed.
     */
    public SchemaSnapshot build(RenameHints hints) {
        MappingHandler mh = manager.getMappingHandler();
        Map<String, TableDescriptor> tables = new LinkedHashMap<>();
        Map<String, ViewDescriptor> views = new LinkedHashMap<>();

        for (MetaDataLoader loader : loaders()) {
            for (MetaObject mc : loader.getMetaObjects()) {
                // Create mapping → TableDef (writable side)
                BaseDef createDef = defOf(mh.getCreateMapping(mc));
                if (createDef instanceof TableDef t) {
                    tables.putIfAbsent(t.getNameDef().getFullname(), tableDescriptor(t, mc));
                }

                // Read mapping → ViewDef (read side, if any)
                BaseDef readDef = defOf(mh.getReadMapping(mc));
                if (readDef instanceof ViewDef v) {
                    views.putIfAbsent(v.getNameDef().getFullname(),
                        new ViewDescriptor(v.getNameDef().getName(), v.getNameDef().getSchema(), v.getSQL()));
                }

                harvestRenameHints(mc, hints);
            }
        }
        return new SchemaSnapshot(new ArrayList<>(tables.values()), new ArrayList<>(views.values()));
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private TableDescriptor tableDescriptor(TableDef t, MetaObject mc) {
        List<ColumnDescriptor> cols = new ArrayList<>();
        List<String> pk = new ArrayList<>();

        for (ColumnDef cd : t.getColumns()) {
            if (cd.getName() == null) continue;
            MetaField<?> mf = fieldForColumn(mc, cd.getName());
            SqlType sqlType = JdbcSqlTypes.fromJdbc(cd.getSQLType(), cd.getLength());
            boolean nullable = mf == null || readNullable(mf); // default: nullable unless @dbNullable=false
            // identity is informational in v1; not surfaced here
            cols.add(new ColumnDescriptor(cd.getName(), sqlType, nullable, null));
            if (cd.isPrimaryKey()) pk.add(cd.getName());
        }

        return new TableDescriptor(
            t.getNameDef().getName(),
            t.getNameDef().getSchema(),
            cols,
            List.of(),   // indexes: empty in v1 (create-table stays additive)
            List.of(),   // foreign keys: empty in v1
            pk);
    }

    private boolean readNullable(MetaField<?> mf) {
        if (!mf.hasMetaAttr(CoreDBMetaDataProvider.DB_NULLABLE)) return true;
        return !"false".equals(mf.getMetaAttr(CoreDBMetaDataProvider.DB_NULLABLE).getValueAsString());
    }

    private MetaField<?> fieldForColumn(MetaObject mc, String column) {
        for (MetaField<?> mf : mc.getMetaFields()) {
            if (column.equalsIgnoreCase(columnNameOf(mf))) return mf;
        }
        return null;
    }

    /** The field's column name: {@code @column} when present, otherwise the field name. */
    private static String columnNameOf(MetaField<?> mf) {
        return mf.hasMetaAttr(CoreDBMetaDataProvider.COLUMN)
            ? mf.getMetaAttr(CoreDBMetaDataProvider.COLUMN).getValueAsString()
            : mf.getName();
    }

    private void harvestRenameHints(MetaObject mc, RenameHints hints) {
        // Determine the table name for this object
        String table = mc.hasMetaAttr(CoreDBMetaDataProvider.DB_TABLE)
            ? mc.getMetaAttr(CoreDBMetaDataProvider.DB_TABLE).getValueAsString()
            : null;
        if (table == null) return;

        // Table-level rename
        if (mc.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME)) {
            hints.addTableRename(table,
                mc.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
        }

        // Column-level renames
        for (MetaField<?> mf : mc.getMetaFields()) {
            if (mf.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME)) {
                hints.addColumnRename(table, columnNameOf(mf),
                    mf.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
            }
        }
    }

    private static BaseDef defOf(ObjectMapping m) {
        return (m instanceof ObjectMappingDB db) ? db.getDBDef() : null;
    }

    private Collection<MetaDataLoader> loaders() {
        return loaderRegistry != null
            ? loaderRegistry.getDataLoaders()
            : com.metaobjects.util.MetaDataUtil.getAllMetaDataLoaders(this);
    }
}
