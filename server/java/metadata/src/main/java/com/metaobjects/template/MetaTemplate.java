package com.metaobjects.template;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MetaTemplate — base for FR-004 prompt/output templates.
 *
 * <p>Cross-port: TS / C# / Python all expose {@code template.base} +
 * concrete subtypes {@code template.output} and {@code template.prompt}.
 * A template binds a payload (a value object) to a named text template
 * resolved by an external provider; the bound metadata is what the
 * render engine consumes at runtime.</p>
 *
 * @since 7.0.0
 */
public abstract class MetaTemplate extends MetaData {

    private static final Logger log = LoggerFactory.getLogger(MetaTemplate.class);

    public static final String TYPE_TEMPLATE = "template";
    public static final String SUBTYPE_BASE = "base";

    /** Reference to the payload value-object the template binds to. */
    public static final String ATTR_PAYLOAD_REF = "payloadRef";
    /** External-provider-resolved name of the template text body. */
    public static final String ATTR_TEXT_REF = "textRef";
    /** Output format hint (e.g. json / xml / html / text). */
    public static final String ATTR_FORMAT = "format";

    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(MetaTemplate.class, def -> {
                def.type(TYPE_TEMPLATE).subType(SUBTYPE_BASE)
                   .description("Base template metadata — payloadRef + textRef + format")
                   .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
                   .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

                def.optionalAttributeWithConstraints(ATTR_PAYLOAD_REF)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

                def.optionalAttributeWithConstraints(ATTR_TEXT_REF)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

                def.optionalAttributeWithConstraints(ATTR_FORMAT)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            });
            log.debug("Registered MetaTemplate type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register MetaTemplate type with unified registry", e);
        }
    }

    public MetaTemplate(String subtype, String name) {
        super(TYPE_TEMPLATE, subtype, name);
    }

    public MetaTemplate(String type, String subtype, String name) {
        super(type, subtype, name);
    }
}
