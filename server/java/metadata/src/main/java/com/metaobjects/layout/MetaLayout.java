package com.metaobjects.layout;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MetaLayout — base for UI/presentation layout metadata attached to an object.
 *
 * <p>Cross-port: TS / C# both expose {@code layout.base} + concrete subtypes
 * such as {@code layout.dataGrid}. Layouts are children of an object and
 * carry shape-of-display attrs (columns, default sort, page size, filter
 * shorthand). They do not influence persistence shape.</p>
 *
 * @since 7.0.0
 */
public abstract class MetaLayout extends MetaData {

    private static final Logger log = LoggerFactory.getLogger(MetaLayout.class);

    public static final String TYPE_LAYOUT = "layout";
    public static final String SUBTYPE_BASE = "base";

    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(MetaLayout.class, def -> def
                .type(TYPE_LAYOUT).subType(SUBTYPE_BASE)
                .description("Base layout metadata — attached to an object, describes UI shape")
                .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
                .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*")
            );
            log.debug("Registered MetaLayout type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register MetaLayout type with unified registry", e);
        }
    }

    public MetaLayout(String subtype, String name) {
        super(TYPE_LAYOUT, subtype, name);
    }

    public MetaLayout(String type, String subtype, String name) {
        super(type, subtype, name);
    }
}
