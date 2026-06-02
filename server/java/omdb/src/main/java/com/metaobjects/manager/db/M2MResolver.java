/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.manager.db;

import com.metaobjects.MetaRoot;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.object.MetaObject;
import com.metaobjects.relationship.M2MFields;
import com.metaobjects.relationship.MetaRelationship;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Generic, metadata-driven M:N query resolver for {@link ObjectManagerDB}.
 *
 * <p>Java port of the TS reference {@code runtime-ts/src/n2m-resolver.ts}. Given a
 * source object and an M:N relationship ({@code @cardinality: "many"} +
 * {@code @objectRef: <target>} + {@code @through: <junction>}), resolve the related
 * target entities by traversing the junction. The junction FK columns are NOT
 * restated on the relationship — they are DERIVED from the junction entity's two
 * {@code identity.reference} children via the shared {@link M2MFields#derive}
 * helper (the cross-port SSOT for FK direction).</p>
 *
 * <p>Three modes (mirroring TS):</p>
 * <ol>
 *   <li><b>Hetero</b> (source != target): query the junction
 *       {@code WHERE sourceFK = source.pk}, collect {@code targetFK}, load the
 *       targets by PK.</li>
 *   <li><b>Directed self-join</b> ({@code @sourceRefField}): identical traversal;
 *       {@link M2MFields#derive} has already picked which junction FK is the source
 *       side, so direction is honored.</li>
 *   <li><b>Symmetric self-join</b> ({@code @symmetric: true}): single-row storage,
 *       union on read — query {@code WHERE sourceFK = id OR targetFK = id}; for each
 *       junction row the related id is whichever FK column is NOT the source id (a
 *       self-pair row {@code (a,a)} yields the source id itself).</li>
 * </ol>
 */
public final class M2MResolver {

    private final ObjectManagerDB omdb;

    public M2MResolver(ObjectManagerDB omdb) {
        this.omdb = omdb;
    }

    /**
     * Resolve the related target entities for an M:N relationship.
     *
     * @param conn        an open connection
     * @param source      the loaded source object (a row instance, e.g. a ValueObject)
     * @param sourceMeta  the source object's metadata
     * @param rel         the M:N relationship declared on {@code sourceMeta}
     * @param root        the loaded model root (to find junction + target entities)
     * @return the related target entity instances (empty when none)
     */
    public Collection<?> resolve(ObjectConnection conn, Object source, MetaObject sourceMeta,
                                 MetaRelationship rel, MetaRoot root) throws Exception {

        M2MFields fields = M2MFields.derive(rel, sourceMeta, root);

        MetaObject junction = mustGetEntity(root, rel.getThrough());
        MetaObject target = mustGetEntity(root, rel.getObjectRef());

        String sourcePkField = primaryKeyField(sourceMeta);
        Object sourceId = readField(sourceMeta, source, sourcePkField);
        if (sourceId == null) return List.of();

        // 1. Query the junction for matching rows.
        //    hetero / directed: sourceFK = sourceId
        //    symmetric: sourceFK = sourceId OR targetFK = sourceId (union-on-read)
        Expression junctionFilter;
        if (rel.isSymmetric()) {
            junctionFilter = new Expression(fields.getSourceField(), sourceId, Expression.EQUAL)
                .or(new Expression(fields.getTargetField(), sourceId, Expression.EQUAL));
        } else {
            junctionFilter = new Expression(fields.getSourceField(), sourceId, Expression.EQUAL);
        }
        QueryOptions junctionOpts = new QueryOptions();
        junctionOpts.setExpression(junctionFilter);
        Collection<?> junctionRows = omdb.getObjects(conn, junction, junctionOpts);

        // 2. Collect the distinct related target ids.
        Set<Object> targetIds = new LinkedHashSet<>();
        for (Object jr : junctionRows) {
            Object relatedId;
            if (rel.isSymmetric()) {
                // The related id is whichever FK column is NOT the source id.
                Object a = readField(junction, jr, fields.getSourceField());
                Object b = readField(junction, jr, fields.getTargetField());
                relatedId = keyEquals(a, sourceId) ? b : a;
            } else {
                relatedId = readField(junction, jr, fields.getTargetField());
            }
            if (relatedId != null) targetIds.add(relatedId);
        }
        if (targetIds.isEmpty()) return List.of();

        // 3. Load the targets by PK (OR'd EQUALs; Java's Expression has no native IN).
        String targetPkField = primaryKeyField(target);
        Expression targetFilter = null;
        for (Object id : targetIds) {
            Expression eq = new Expression(targetPkField, id, Expression.EQUAL);
            targetFilter = targetFilter == null ? eq : targetFilter.or(eq);
        }
        QueryOptions targetOpts = new QueryOptions();
        targetOpts.setExpression(targetFilter);
        return new ArrayList<>(omdb.getObjects(conn, target, targetOpts));
    }

    // --- helpers -----------------------------------------------------------

    /** The single primary-key field name of an entity. */
    private static String primaryKeyField(MetaObject mc) {
        PrimaryIdentity pk = mc.getPrimaryIdentity();
        if (pk == null) {
            throw new IllegalStateException("Entity '" + mc.getShortName() + "' has no identity.primary");
        }
        List<String> pkFields = pk.getFields();
        if (pkFields == null || pkFields.isEmpty()) {
            throw new IllegalStateException("identity.primary on '" + mc.getShortName() + "' declares no @fields");
        }
        return pkFields.get(0);
    }

    /** Read a field value off a loaded instance via its MetaField. */
    private static Object readField(MetaObject mc, Object instance, String fieldName) {
        return mc.getMetaField(fieldName).getObject(instance);
    }

    /**
     * Compare two key values by string-coerced identity. The source id comes from
     * the in-process source record (e.g. a Long) while the junction FK value comes
     * straight off the driver (which may surface a BIGINT key as a different numeric
     * type); comparing by toString() bridges that the same way the TS resolver does.
     */
    private static boolean keyEquals(Object a, Object b) {
        if (a == null || b == null) return a == b;
        return String.valueOf(a).equals(String.valueOf(b));
    }

    private static MetaObject mustGetEntity(MetaRoot root, String name) {
        String bare = stripPackage(name);
        for (var child : root.getChildren(MetaObject.class, false)) {
            if (bare.equals(child.getShortName())) return child;
        }
        throw new IllegalStateException("Entity '" + name + "' not found in model root");
    }

    private static String stripPackage(String name) {
        if (name == null) return null;
        int idx = name.lastIndexOf(com.metaobjects.MetaData.PKG_SEPARATOR);
        return (idx >= 0) ? name.substring(idx + com.metaobjects.MetaData.PKG_SEPARATOR.length()) : name;
    }
}
