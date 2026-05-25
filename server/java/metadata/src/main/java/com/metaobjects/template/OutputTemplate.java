package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * OutputTemplate — {@code template.output}. Renders a value-object payload to
 * a target format (json / xml / html / text). Cross-port FR-004.
 */
public class OutputTemplate extends MetaTemplate {

    private static final Logger log = LoggerFactory.getLogger(OutputTemplate.class);

    public static final String SUBTYPE_OUTPUT = "output";

    public OutputTemplate(String name) {
        super(TYPE_TEMPLATE, SUBTYPE_OUTPUT, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(OutputTemplate.class, def -> def
                .type(TYPE_TEMPLATE).subType(SUBTYPE_OUTPUT)
                .description("Output template — renders a value object to a target format")
                .inheritsFrom(TYPE_TEMPLATE, SUBTYPE_BASE)
            );
            log.debug("Registered OutputTemplate type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register OutputTemplate type with unified registry", e);
        }
    }
}
