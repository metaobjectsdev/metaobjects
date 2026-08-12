package com.metaobjects.template;

import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * LLM tool-call envelope template ({@code template.toolcall}) — ADR-0011.
 *
 * <p>Vendor-agnostic in core; vendor wire details (Anthropic's retry-with-reminder,
 * OpenAI's function-calling envelope, MCP's tool definitions, etc.) are NOT in
 * core. Consumers add vendor specifics via a provider that registers additional
 * attrs on this subtype (the Java port's equivalent of TypeScript's
 * {@code registry.extend(TYPE_TEMPLATE, "toolcall", ...)} mechanism).
 *
 * <p>Crucially: {@code template.toolcall} does NOT inherit the generic
 * {@code @payloadRef}/{@code @textRef}/{@code @format} attrs that
 * {@link PromptTemplate} and {@link OutputTemplate} share. It declares its own
 * minimal set: required {@code @toolName} + required {@code @payloadRef} +
 * governance {@code @owner}/{@code @since}. {@code @textRef} is intentionally
 * absent — a tool-call has no renderable text body; the body IS the structured
 * output schema resolved via {@code @payloadRef}.
 *
 * <p>{@code @description} is intentionally NOT declared here — it's added to
 * every type by the documentation common-attrs provider. Tool descriptions
 * surfaced to the LLM use the same {@code @description} common attr that
 * doc-gen uses.
 */
public final class ToolcallTemplate extends MetaTemplate {

    public ToolcallTemplate(String name) {
        super(SUBTYPE_TOOLCALL, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ToolcallTemplate.class, def -> {
            // ADR-0011: toolcall does NOT inheritsFrom template.base because the
            // shared @textRef / @format / @maxChars / @requiredTags attrs do NOT
            // apply to toolcall. Bind directly to metadata.base instead — match
            // template.base's own inheritance.
            def.type(TYPE_TEMPLATE).subType(SUBTYPE_TOOLCALL)
               .description("Template (LLM tool-call envelope) — ADR-0011")
               .inheritsFrom(com.metaobjects.MetaData.TYPE_METADATA,
                             com.metaobjects.MetaData.SUBTYPE_BASE)
               // Accept any attr child (vendor providers add their own).
               .optionalChild(com.metaobjects.attr.MetaAttribute.TYPE_ATTR, "*", "*");

            // OWN attrs, registered here — never in a composable concern provider —
            // because @toolName and @payloadRef are REQUIRED (see MetaTemplate's note
            // on why a required attr must never live somewhere that can be composed
            // out). Matches spec/metamodel/template.json's template.toolcall
            // declaration exactly. The any-attr wildcard above keeps vendor
            // extensibility.
            def.requiredAttributeWithConstraints(ATTR_TOOL_NAME)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ATTR_PAYLOAD_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_OWNER)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_SINCE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_MAX_TOKENS)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();
        });
    }

    /**
     * Returns the raw value of {@code @toolName}, or {@code null} if absent.
     * ADR-0039: template.* attrs resolve through extends (includeParentData=true,
     * the default) — matching the TS reference + C#.
     */
    public String getToolName() {
        return hasMetaAttr(ATTR_TOOL_NAME)
            ? getMetaAttr(ATTR_TOOL_NAME).getValueAsString()
            : null;
    }
}
