package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * Non-LLM rendered artifact template ({@code template.output}) — FR-004.
 *
 * <p>Email / export / docs / config — anything with {@code @format} + payload
 * + template text that isn't an LLM prompt.
 *
 * <p>FR-010 adds {@code @promptStyle} (closed enum: {@code guide|inline|exampleOnly},
 * default {@code guide}) that governs how the output-format prompt fragment is laid out.
 */
public final class OutputTemplate extends MetaTemplate {

    public OutputTemplate(String name) {
        super(SUBTYPE_OUTPUT, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(OutputTemplate.class, def -> {
            def.type(TYPE_TEMPLATE).subType(SUBTYPE_OUTPUT)
               .description("Template (non-LLM output) — FR-004")
               .inheritsFrom(TYPE_TEMPLATE, SUBTYPE_BASE);

            // FR-033: the shared template attrs (@payloadRef [REQUIRED] / @textRef /
            // @format / @maxChars / @owner / @since / @requiredTags) and the output
            // overlay (@promptStyle / @kind / @subjectRef / @htmlBodyRef /
            // @textBodyRef) are re-homed to the metaobjects-prompt concern provider
            // (reads spec/metamodel/prompt.json's template.output extends). The
            // closed-set + conditional-ref checks (@format / @promptStyle / @kind,
            // email refs) remain enforced post-load in ValidationPhase. The any-attr
            // wildcard is inherited from template.base.
        });
    }

    /**
     * Returns the value of {@code @promptStyle} if explicitly set, else
     * {@link TemplateConstants#PROMPT_STYLE_DEFAULT} ({@code "guide"}).
     * ADR-0039: template.* attrs resolve through extends (includeParentData=true,
     * the default) — matching the TS reference + C#.
     */
    public String getPromptStyle() {
        if (!hasMetaAttr(ATTR_PROMPT_STYLE)) return PROMPT_STYLE_DEFAULT;
        String v = getMetaAttr(ATTR_PROMPT_STYLE).getValueAsString();
        return v != null ? v : PROMPT_STYLE_DEFAULT;
    }
}
