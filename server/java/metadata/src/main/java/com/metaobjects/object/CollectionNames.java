package com.metaobjects.object;

import com.metaobjects.database.NamingStrategies;
import com.metaobjects.database.PhysicalNaming;

/**
 * An object's collection name: its own {@code @collectionName}, else the project's pluralizer
 * ({@code naming.collections}) over its name. Each artifact applies its own casing (a reverse
 * {@code @via} hop: lowerFirst). Mirrors TS {@code collectionNameOf} / C# {@code CollectionNames}.
 */
public final class CollectionNames {

    private CollectionNames() {}

    /**
     * The collection name of {@code obj}, in its own casing. Own, not resolving: a name inherited
     * from an abstract base would hand every subtype one collection.
     */
    public static String of(MetaObject obj) {
        String declared = declared(obj);
        if (declared != null) return declared;
        String configured = PhysicalNaming.of(obj).collections();
        return NamingStrategies.pluralizer(configured != null ? configured : NamingStrategies.DEFAULT_PLURALIZER)
            .apply(obj.getShortName());
    }

    /** The collection name {@code obj} declares ({@code @collectionName}), or {@code null}. */
    public static String declared(MetaObject obj) {
        // ADR-0039: own — a collection name is the declaring object's alone (see of).
        if (!obj.hasMetaAttr(MetaObject.ATTR_COLLECTION_NAME, false)) return null;
        Object v = obj.getMetaAttr(MetaObject.ATTR_COLLECTION_NAME, false).getValue();
        return v instanceof String && !((String) v).isEmpty() ? (String) v : null;
    }
}
