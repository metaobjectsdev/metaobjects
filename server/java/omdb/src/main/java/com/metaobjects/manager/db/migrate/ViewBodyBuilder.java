package com.metaobjects.manager.db.migrate;

import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.origin.AggregateOrigin;
import com.metaobjects.origin.MetaOrigin;
import com.metaobjects.origin.PassthroughOrigin;
import com.metaobjects.relationship.MetaRelationship;

import java.util.List;
import java.util.Map;

/**
 * Build a PostgreSQL view-body SQL clause from a projection entity (a
 * read-only {@code source.rdb}) by walking each field's origin.
 *
 * <p>v1 supports:</p>
 * <ul>
 *   <li>{@code origin.passthrough} (no {@code @via}) — plain column from the
 *       single base entity</li>
 *   <li>{@code origin.aggregate} ({@code @agg}/{@code @of}/{@code @via}) —
 *       correlated subquery over a to-many relationship</li>
 * </ul>
 *
 * <p>Deferred to v2 (returns {@code null} → caller omits the view from the
 * snapshot):</p>
 * <ul>
 *   <li>{@code origin.passthrough} WITH {@code @via} (to-one correlated subquery)</li>
 *   <li>{@code origin.collection} (json_agg)</li>
 *   <li>multi-base projections</li>
 * </ul>
 *
 * <p>Cross-port: mirrors {@code expected-views.ts} (TS) and
 * {@code PostgresSchema.CreateView} (C#). Identifiers are quoted throughout
 * so mixed-case columns (e.g. {@code "programId"}) survive PG case-folding.</p>
 */
final class ViewBodyBuilder {

    private ViewBodyBuilder() {}

    /** Compute {@code "SELECT ...\nFROM ..."} for a projection, or null when unresolvable. */
    static String buildSql(MetaObject projection, Map<String, MetaObject> entityByName) {
        StringBuilder cols = new StringBuilder();
        String baseEntity = null;
        final String T = "t"; // target alias in correlated subqueries (self-reference safe)

        int n = 0;
        for (MetaField<?> f : projection.getMetaFields()) {
            MetaOrigin origin = firstOrigin(f);
            if (origin == null) return null; // field has no resolvable origin
            String fieldCol = columnOf(f);

            // passthrough (no @via) → plain column off the single base
            if (origin instanceof PassthroughOrigin pt && pt.getVia() == null
                    && pt.getFrom() != null && pt.getFrom().contains(".")) {
                String[] parts = splitDot(pt.getFrom());
                String bare = stripPkg(parts[0]);
                if (baseEntity == null) baseEntity = bare;
                else if (!bare.equals(baseEntity)) return null; // multi-base projection
                MetaObject srcEntity = entityByName.get(baseEntity);
                String srcCol = columnByFieldName(srcEntity, parts[1]);
                if (n++ > 0) cols.append(",\n");
                cols.append("  \"").append(srcCol).append("\" AS \"").append(fieldCol).append("\"");
            }
            // aggregate (@agg/@of/@via) → correlated subquery over a to-many
            else if (origin instanceof AggregateOrigin agg && agg.getAgg() != null
                    && agg.getOf() != null && agg.getVia() != null
                    && agg.getOf().contains(".") && agg.getVia().contains(".")) {
                String[] viaParts = splitDot(agg.getVia());
                String bare = stripPkg(viaParts[0]);
                if (baseEntity == null) baseEntity = bare;
                else if (!bare.equals(baseEntity)) return null;
                ToManyFk fk = resolveToManyFk(entityByName, baseEntity, viaParts[1]);
                if (fk == null) return null;
                String ofCol = columnByFieldName(fk.target, splitDot(agg.getOf())[1]);
                String baseTable = baseTable(entityByName, baseEntity);
                if (n++ > 0) cols.append(",\n");
                cols.append("  (SELECT ").append(agg.getAgg())
                    .append("(").append(T).append(".\"").append(ofCol).append("\") FROM \"")
                    .append(fk.targetTable).append("\" ").append(T).append(" WHERE ").append(T)
                    .append(".\"").append(fk.fkCol).append("\" = \"").append(baseTable)
                    .append("\".\"").append(fk.parentCol).append("\") AS \"").append(fieldCol).append("\"");
            }
            // passthrough WITH via OR collection origins — not implemented in v1
            else {
                return null;
            }
        }

        if (baseEntity == null || n == 0) return null;
        return "SELECT\n" + cols + "\nFROM \"" + baseTable(entityByName, baseEntity) + "\"";
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static MetaOrigin firstOrigin(MetaField<?> f) {
        for (var child : f.getChildren()) {
            if (child instanceof MetaOrigin o) return o;
        }
        return null;
    }

    private static String[] splitDot(String s) {
        int i = s.indexOf('.');
        return new String[] { s.substring(0, i), s.substring(i + 1) };
    }

    private static String stripPkg(String name) {
        int i = name.lastIndexOf("::");
        return i < 0 ? name : name.substring(i + 2);
    }

    private static String columnOf(MetaField<?> f) {
        return f.hasMetaAttr(CoreDBMetaDataProvider.COLUMN)
            ? f.getMetaAttr(CoreDBMetaDataProvider.COLUMN).getValueAsString()
            : f.getName();
    }

    private static String columnByFieldName(MetaObject owner, String fieldName) {
        if (owner == null) return fieldName;
        for (MetaField<?> mf : owner.getMetaFields()) {
            if (mf.getName().equals(fieldName)) return columnOf(mf);
        }
        return fieldName;
    }

    private static String baseTable(Map<String, MetaObject> entityByName, String entityName) {
        MetaObject e = entityByName.get(entityName);
        if (e == null) return entityName;
        String t = e.getPrimaryRdbTableName();
        return t != null ? t : entityName;
    }

    private record ToManyFk(MetaObject target, String targetTable, String fkCol, String parentCol) {}

    /** Resolve a to-many relationship to (target, FK column on target, parent PK column on base). */
    private static ToManyFk resolveToManyFk(Map<String, MetaObject> entityByName, String baseEntityName, String relName) {
        MetaObject baseObj = entityByName.get(baseEntityName);
        if (baseObj == null) return null;
        MetaRelationship rel = relationshipByShortName(baseObj, relName);
        if (rel == null || rel.getObjectRef() == null) return null;
        MetaObject target = entityByName.get(stripPkg(rel.getObjectRef()));
        if (target == null) return null;
        String targetTable = target.getPrimaryRdbTableName();
        if (targetTable == null) return null;

        ReferenceIdentity fkRef = referenceIdentityToward(target, baseEntityName);
        if (fkRef == null || fkRef.getFields().isEmpty()) return null;

        String fkCol = columnByFieldName(target, fkRef.getFields().get(0));
        String parentCol = columnByFieldName(baseObj, resolveParentField(baseObj, fkRef));
        return new ToManyFk(target, targetTable, fkCol, parentCol);
    }

    private static MetaRelationship relationshipByShortName(MetaObject owner, String shortName) {
        for (MetaRelationship r : owner.getRelationships()) {
            if (shortName.equals(r.getShortName())) return r;
        }
        return null;
    }

    private static ReferenceIdentity referenceIdentityToward(MetaObject owner, String targetShortName) {
        for (MetaIdentity id : owner.getIdentities()) {
            if (!(id instanceof ReferenceIdentity r)) continue;
            String te = r.getTargetEntity();
            if (te != null && stripPkg(te).equals(targetShortName)) return r;
        }
        return null;
    }

    /** Parent (base) field the FK targets: explicit @targetFields[0] if set, else base PK[0], else "id". */
    private static String resolveParentField(MetaObject baseObj, ReferenceIdentity fkRef) {
        List<String> targetFields = fkRef.getTargetFields();
        if (targetFields != null && !targetFields.isEmpty()) return targetFields.get(0);
        PrimaryIdentity pk = baseObj.getPrimaryIdentity();
        return (pk == null || pk.getFields().isEmpty()) ? "id" : pk.getFields().get(0);
    }
}
