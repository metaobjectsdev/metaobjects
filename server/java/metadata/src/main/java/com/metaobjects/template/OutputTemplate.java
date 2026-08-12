package com.metaobjects.template;

import com.metaobjects.attr.IntAttribute;
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

            // OWN attrs, registered here — never in a composable concern provider —
            // because @payloadRef is REQUIRED (see MetaTemplate's note on why a
            // required attr must never live somewhere that can be composed out).
            // Matches spec/metamodel/template.json's template.output declaration
            // exactly. The closed-set + conditional-ref checks (@format /
            // @promptStyle / @kind, email refs) remain enforced post-load in
            // ValidationPhase. The any-attr wildcard is inherited from template.base.

            // Shared reference + governance attrs (peer of template.prompt's set).
            def.requiredAttributeWithConstraints(ATTR_PAYLOAD_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_TEXT_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_FORMAT)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(FORMAT_TEXT, FORMAT_HTML, FORMAT_XML, FORMAT_CSV,
                         FORMAT_JSON, FORMAT_MARKDOWN, FORMAT_SPREADSHEET);
            def.optionalAttributeWithConstraints(ATTR_MAX_CHARS)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();
            def.optionalAttributeWithConstraints(ATTR_OWNER)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_SINCE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_REQUIRED_TAGS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            // Output overlay (template.output only — FR-010 @promptStyle + @kind/email
            // part-refs).
            def.optionalAttributeWithConstraints(ATTR_PROMPT_STYLE)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(PROMPT_STYLE_GUIDE, PROMPT_STYLE_INLINE, PROMPT_STYLE_EXAMPLE_ONLY);
            def.optionalAttributeWithConstraints(ATTR_KIND)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(KIND_DOCUMENT, KIND_EMAIL);
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
     * ADR-0039: template.* attrs resolve through extends (includeParentData=true,
     * the default) — matching the TS reference + C#.
     */
    public String getPromptStyle() {
        if (!hasMetaAttr(ATTR_PROMPT_STYLE)) return PROMPT_STYLE_DEFAULT;
        String v = getMetaAttr(ATTR_PROMPT_STYLE).getValueAsString();
        return v != null ? v : PROMPT_STYLE_DEFAULT;
    }
}
