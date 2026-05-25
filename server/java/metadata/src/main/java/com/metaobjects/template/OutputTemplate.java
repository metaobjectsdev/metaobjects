package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * Non-LLM rendered artifact template ({@code template.output}) — FR-004.
 *
 * <p>Email / export / docs / config — anything with {@code @format} + payload
 * + template text that isn't an LLM prompt. No subtype-specific attributes
 * beyond what {@link MetaTemplate} provides.
 */
public final class OutputTemplate extends MetaTemplate {

    public OutputTemplate(String name) {
        super(SUBTYPE_OUTPUT, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(OutputTemplate.class, def -> def
            .type(TYPE_TEMPLATE).subType(SUBTYPE_OUTPUT)
            .description("Template (non-LLM output) — FR-004")
            .inheritsFrom(TYPE_TEMPLATE, SUBTYPE_BASE));
    }
}
