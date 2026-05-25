package com.metaobjects.manager.db.migrate;

import com.metaobjects.MetaData;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.identity.SecondaryIdentity;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.MappingHandler;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.ObjectMapping;
import com.metaobjects.manager.db.ObjectMappingDB;
import com.metaobjects.manager.db.defs.BaseDef;
import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.ColumnDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.FkDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.IndexDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.TableDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.ViewDescriptor;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.source.MetaSource;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Builds the EXPECTED {@link SchemaSnapshot} from metadata.
 *
 * <p>Column shapes still come through the legacy {@link MappingHandler}-derived
 * {@link TableDef} (so existing object-mapping consumers like the Derby
 * fixture path keep working), but everything new-style enrichment lives here:
 * NOT-NULL inference from {@code identity.primary} + {@code @required},
 * unique-index emission from {@code identity.secondary}, FK emission from
 * {@code identity.reference}, and projection view bodies computed from
 * {@code origin.passthrough} / {@code origin.aggregate} children.</p>
 *
 * <p>Cross-port: mirrors {@code expected-schema.ts} + {@code expected-views.ts}
 * (TS) and {@code MetaObjects.Codegen.Migrate.ExpectedSchema} +
 * {@code MetaObjects.Codegen.Schema.PostgresSchema.CreateView} (C#).</p>
 */
public final class ExpectedSchemaBuilder {

    private final ObjectManagerDB manager;
    private final MetaDataLoaderRegistry loaderRegistry;

    public ExpectedSchemaBuilder(ObjectManagerDB manager, MetaDataLoaderRegistry loaderRegistry) {
        this.manager = manager;
        this.loaderRegistry = loaderRegistry;
    }

    /** Build the snapshot; fills {@code hints} as a side-effect. */
    public SchemaSnapshot build(RenameHints hints) {
        MappingHandler mh = manager.getMappingHandler();
        Map<String, TableDescriptor> tables = new LinkedHashMap<>();
        Map<String, ViewDescriptor> views = new LinkedHashMap<>();

        // Pass 1: build tables + collect entities by short-name + harvest renames.
        // View bodies need the name→entity map to resolve `@from`/`@via` cross-entity refs,
        // so the view pass runs after this loop completes.
        Map<String, MetaObject> entityByName = new LinkedHashMap<>();
        for (MetaDataLoader loader : loaders()) {
            for (MetaObject mc : loader.getMetaObjects()) {
                entityByName.putIfAbsent(mc.getShortName(), mc);
                BaseDef createDef = defOf(mh.getCreateMapping(mc));
                if (createDef instanceof TableDef t) {
                    tables.putIfAbsent(t.getNameDef().getFullname(), tableDescriptor(t, mc));
                }
                harvestRenameHints(mc, hints);
            }
        }

        // Pass 2: projection view bodies derived from origin children.
        for (MetaObject mc : entityByName.values()) {
            String viewName = mc.getPrimaryRdbViewName();
            if (viewName == null) continue;
            String body = ViewBodyBuilder.buildSql(mc, entityByName);
            if (body == null) continue; // unresolvable projection — leave out (cross-port: TS also drops)
            String viewSchema = mc.findPrimaryReadOnlySource().map(MetaSource::getSchema).orElse(null);
            String fullName = (viewSchema == null ? "" : viewSchema + ".") + viewName;
            views.putIfAbsent(fullName, new ViewDescriptor(viewName, viewSchema, body));
        }

        return new SchemaSnapshot(new ArrayList<>(tables.values()), new ArrayList<>(views.values()));
    }

    // -------------------------------------------------------------------------
    // Table descriptor (columns + indexes + FKs + PK)
    // -------------------------------------------------------------------------

    private TableDescriptor tableDescriptor(TableDef t, MetaObject mc) {
        List<ColumnDescriptor> cols = new ArrayList<>();
        List<String> pk = new ArrayList<>();
        Set<String> pkFieldNames = primaryIdentityFieldNames(mc);

        for (ColumnDef cd : t.getColumns()) {
            if (cd.getName() == null) continue;
            MetaField<?> mf = fieldForColumn(mc, cd.getName());
            SqlType sqlType = JdbcSqlTypes.fromJdbc(cd.getSQLType(), cd.getLength());
            // Unmapped columns default to nullable; mapped columns are nullable unless part of the
            // primary identity, marked @required, or explicitly @dbNullable=false.
            boolean isPk = mf != null && pkFieldNames.contains(mf.getName());
            boolean nullable = mf == null || (!isPk && !isRequired(mf) && readNullable(mf));
            cols.add(new ColumnDescriptor(cd.getName(), sqlType, nullable, null));
            if (cd.isPrimaryKey() || isPk) pk.add(cd.getName());
        }

        return new TableDescriptor(
            t.getNameDef().getName(),
            t.getNameDef().getSchema(),
            cols,
            buildIndexes(mc),
            buildForeignKeys(mc),
            pk);
    }

    /** True when {@code @required} is explicitly set to "true". */
    private static boolean isRequired(MetaField<?> mf) {
        return mf.hasMetaAttr(MetaField.ATTR_REQUIRED)
            && "true".equalsIgnoreCase(mf.getMetaAttr(MetaField.ATTR_REQUIRED).getValueAsString());
    }

    /** True (nullable) unless the legacy {@code @dbNullable} attr explicitly says "false". */
    private static boolean readNullable(MetaField<?> mf) {
        return !mf.hasMetaAttr(CoreDBMetaDataProvider.DB_NULLABLE)
            || !"false".equals(mf.getMetaAttr(CoreDBMetaDataProvider.DB_NULLABLE).getValueAsString());
    }

    private static Set<String> primaryIdentityFieldNames(MetaObject mc) {
        PrimaryIdentity pk = mc.getPrimaryIdentity();
        return pk == null ? Set.of() : Set.copyOf(pk.getFields());
    }

    // -------------------------------------------------------------------------
    // Indexes (secondary identities)
    // -------------------------------------------------------------------------

    private static List<IndexDescriptor> buildIndexes(MetaObject mc) {
        List<IndexDescriptor> indexes = new ArrayList<>();
        for (SecondaryIdentity sec : mc.getSecondaryIdentities()) {
            List<String> cols = sec.getFields().stream().map(n -> columnFor(mc, n)).toList();
            if (cols.isEmpty()) continue;
            // Secondary identities are unique unless explicitly @unique:false (mirrors TS).
            boolean unique = !"false".equalsIgnoreCase(attrOrNull(sec, "unique"));
            // Use the short name (Java's getName() returns the FQN like "fitness::byTitle";
            // the cross-port assertion vocabulary expects the bare identifier).
            indexes.add(new IndexDescriptor(sec.getShortName(), cols, unique));
        }
        return indexes;
    }

    // -------------------------------------------------------------------------
    // Foreign keys (reference identities)
    // -------------------------------------------------------------------------

    private List<FkDescriptor> buildForeignKeys(MetaObject mc) {
        String owningTable = mc.getPrimaryRdbTableName();
        if (owningTable == null) return List.of();

        List<FkDescriptor> fks = new ArrayList<>();
        for (MetaIdentity id : mc.getIdentities()) {
            if (!(id instanceof ReferenceIdentity ref) || !ref.isEnforced()) continue;
            String targetName = ref.getTargetEntity();
            if (targetName == null || ref.getFields().isEmpty()) continue;
            MetaObject target = findEntity(targetName);
            if (target == null) continue;
            String refTable = target.getPrimaryRdbTableName();
            if (refTable == null) continue;

            List<String> cols = ref.getFields().stream().map(n -> columnFor(mc, n)).toList();
            List<String> refTargetFields = ref.getTargetFields();
            List<String> refCols = refTargetFields.size() > 1
                ? refTargetFields.stream().map(n -> columnFor(target, n)).toList()
                : List.of(columnFor(target, resolvedTargetPkField(target, ref)));

            String onDelete = matchingRelationshipAction(mc, targetName, true);
            String onUpdate = matchingRelationshipAction(mc, targetName, false);

            String name = owningTable + "_" + cols.get(0) + "_fk";
            fks.add(new FkDescriptor(name, cols, refTable, refCols, onDelete, onUpdate));
        }
        return fks;
    }

    private static String resolvedTargetPkField(MetaObject target, ReferenceIdentity fk) {
        if (fk.getTargetFields().size() == 1) return fk.getTargetFields().get(0);
        PrimaryIdentity pk = target.getPrimaryIdentity();
        return (pk == null || pk.getFields().isEmpty()) ? "id" : pk.getFields().get(0);
    }

    /** Pair a reference identity to its matching relationship by @objectRef, read its @onDelete/@onUpdate. */
    private static String matchingRelationshipAction(MetaObject owner, String targetEntity, boolean delete) {
        // Strip package qualifier once (handles both "Target" and "pkg::Target" forms).
        String bareTarget = stripPkg(targetEntity);
        for (MetaRelationship rel : owner.getRelationships()) {
            String objectRef = rel.getObjectRef();
            if (objectRef == null || !stripPkg(objectRef).equals(bareTarget)) continue;
            return delete ? rel.getOnDeleteRaw() : rel.getOnUpdateRaw();
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Field-name / column-name helpers
    // -------------------------------------------------------------------------

    private static MetaField<?> fieldForColumn(MetaObject mc, String column) {
        for (MetaField<?> mf : mc.getMetaFields()) {
            if (column.equalsIgnoreCase(columnNameOf(mf))) return mf;
        }
        return null;
    }

    private static String columnFor(MetaObject mc, String fieldName) {
        for (MetaField<?> mf : mc.getMetaFields()) {
            if (mf.getName().equals(fieldName)) return columnNameOf(mf);
        }
        return fieldName; // fallback to bare name (matches cross-port stale-FK behavior)
    }

    /** The field's column name: {@code @column} when present, otherwise the field name. */
    private static String columnNameOf(MetaField<?> mf) {
        return mf.hasMetaAttr(CoreDBMetaDataProvider.COLUMN)
            ? mf.getMetaAttr(CoreDBMetaDataProvider.COLUMN).getValueAsString()
            : mf.getName();
    }

    private static String stripPkg(String name) {
        int i = name.lastIndexOf("::");
        return i < 0 ? name : name.substring(i + 2);
    }

    private static String attrOrNull(MetaData md, String attr) {
        return md.hasMetaAttr(attr) ? md.getMetaAttr(attr).getValueAsString() : null;
    }

    // -------------------------------------------------------------------------
    // Rename hints
    // -------------------------------------------------------------------------

    private void harvestRenameHints(MetaObject mc, RenameHints hints) {
        String table = mc.getPrimaryRdbTableName();
        if (table == null) return;
        if (mc.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME)) {
            hints.addTableRename(table,
                mc.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
        }
        for (MetaField<?> mf : mc.getMetaFields()) {
            if (mf.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME)) {
                hints.addColumnRename(table, columnNameOf(mf),
                    mf.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
            }
        }
    }

    // -------------------------------------------------------------------------
    // Misc
    // -------------------------------------------------------------------------

    private static BaseDef defOf(ObjectMapping m) {
        return (m instanceof ObjectMappingDB db) ? db.getDBDef() : null;
    }

    private Collection<MetaDataLoader> loaders() {
        return loaderRegistry != null
            ? loaderRegistry.getDataLoaders()
            : com.metaobjects.util.MetaDataUtil.getAllMetaDataLoaders(this);
    }

    private MetaObject findEntity(String name) {
        String bare = stripPkg(name);
        for (MetaDataLoader loader : loaders()) {
            for (MetaObject mc : loader.getMetaObjects()) {
                if (mc.getShortName().equals(bare)) return mc;
            }
        }
        return null;
    }
}
