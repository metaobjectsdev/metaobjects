package com.metaobjects.template;

import com.metaobjects.attr.StringAttribute;
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

            // @promptStyle — closed enum (guide|inline|exampleOnly), default "guide".
            // Validation (out-of-set rejection) is enforced in
            // ValidationPhase#validateTemplates in the same post-load pass that
            // enforces @format; same pattern, same reason (CustomConstraint
            // applicability doesn't fire for concrete subtypes at addChild time).
            def.optionalAttributeWithConstraints(ATTR_PROMPT_STYLE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // @kind — closed enum (document|email), default "document". Closed-set
            // membership is enforced in ValidationPhase#validateTemplates (same
            // pattern/reason as @format / @promptStyle). The conditional ref
            // requirements (email → @subjectRef + @htmlBodyRef; document → @textRef)
            // are likewise enforced there.
            def.optionalAttributeWithConstraints(ATTR_KIND)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // Email part-refs (template.output @kind="email"). Optional 2-layer
            // logical (group/source) textRefs; conditional presence enforced in
            // ValidationPhase#validateTemplates.
            def.optionalAttributeWithConstraints(ATTR_SUBJECT_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_HTML_BODY_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_TEXT_BODY_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    /**
     * Returns the value of {@code @promptStyle} if explicitly set, else
     * {@link TemplateConstants#PROMPT_STYLE_DEFAULT} ({@code "guide"}).
     */
    public String getPromptStyle() {
        if (!hasMetaAttr(ATTR_PROMPT_STYLE, false)) return PROMPT_STYLE_DEFAULT;
        String v = getMetaAttr(ATTR_PROMPT_STYLE, false).getValueAsString();
        return v != null ? v : PROMPT_STYLE_DEFAULT;
    }
}
