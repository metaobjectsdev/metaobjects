package com.metaobjects.field;

import com.metaobjects.MetaData;
import com.metaobjects.database.ColumnNaming;
import com.metaobjects.loader.References;
import com.metaobjects.object.MetaObject;

/**
 * A path into a member of a FLATTENED value object ({@code address.city}): the member's column
 * lives on the owning table, under the embedding field's prefix
 * ({@link ColumnNaming#resolveFlattened}). One resolver for the loader and every lowering.
 * Mirrors TS {@code flattened-member.ts} / C# {@code FlattenedMember}.
 *
 * @param embedding the embedding {@code field.object} on the entity
 * @param member    the member field its value object declares
 */
public record FlattenedMember(MetaField<?> embedding, MetaField<?> member) {

    /**
     * Resolve {@code <field>.<member>} against {@code entity}: {@code <field>} a scalar
     * {@code field.object} with {@code @storage: flattened}, {@code <member>} a field its
     * {@code @objectRef} value object declares (effective). {@code null} for anything else — a
     * plain field name, a jsonb object, an array, an unknown member. One level only.
     */
    public static FlattenedMember resolve(MetaObject entity, String path) {
        if (path == null) return null;
        int dot = path.indexOf('.');
        if (dot < 1 || dot == path.length() - 1 || path.indexOf('.', dot + 1) != -1) return null;
        String head = path.substring(0, dot);
        String tail = path.substring(dot + 1);
        // ADR-0039: resolving — the embedding field may be inherited via extends.
        MetaField<?> embedding = field(entity, head);
        if (embedding == null || !ObjectField.SUBTYPE_OBJECT.equals(embedding.getSubType())) return null;
        // ADR-0039: resolving — @storage / @objectRef may be inherited via extends.
        if (!embedding.hasMetaAttr(MetaField.ATTR_STORAGE, true)
                || !ObjectField.STORAGE_FLATTENED.equals(embedding.getMetaAttr(MetaField.ATTR_STORAGE, true).getValueAsString())) {
            return null;
        }
        MetaObject vo = References.refTarget(embedding, MetaField.ATTR_OBJECT_REF);
        if (vo == null) return null;
        MetaField<?> member = field(vo, tail);
        return member == null ? null : new FlattenedMember(embedding, member);
    }

    private static MetaField<?> field(MetaObject obj, String name) {
        for (MetaData c : obj.getChildren(MetaData.class, true)) {
            if (c instanceof MetaField && name.equals(c.getShortName())) return (MetaField<?>) c;
        }
        return null;
    }
}
