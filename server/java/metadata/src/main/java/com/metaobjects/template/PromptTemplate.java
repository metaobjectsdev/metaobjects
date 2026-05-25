package com.metaobjects.template;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * PromptTemplate — {@code template.prompt}. Binds a payload to an LLM prompt
 * text body resolved by an external provider. Adds an optional
 * {@code @requiredSlots} string-array attr listing the payload fields the
 * prompt body relies on.
 */
public class PromptTemplate extends MetaTemplate {

    private static final Logger log = LoggerFactory.getLogger(PromptTemplate.class);

    public static final String SUBTYPE_PROMPT = "prompt";
    /** Field names on the payload that the prompt body must reference. */
    public static final String ATTR_REQUIRED_SLOTS = "requiredSlots";

    public PromptTemplate(String name) {
        super(TYPE_TEMPLATE, SUBTYPE_PROMPT, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(PromptTemplate.class, def -> {
                def.type(TYPE_TEMPLATE).subType(SUBTYPE_PROMPT)
                   .description("Prompt template — binds a payload to an LLM prompt body")
                   .inheritsFrom(TYPE_TEMPLATE, SUBTYPE_BASE);

                def.optionalAttributeWithConstraints(ATTR_REQUIRED_SLOTS)
                   .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            });
            log.debug("Registered PromptTemplate type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register PromptTemplate type with unified registry", e);
        }
    }
}
