package com.metaobjects.template;

import java.util.Set;

/**
 * Vocabulary constants for the {@code template.*} metatype (FR-004).
 *
 * <p>Type/subtype names and attribute names are Tier-1 cross-language
 * invariants — they must match TS ({@code packages/metadata/src/template/})
 * and C# ({@code MetaObjects/Template/TemplateConstants.cs}) exactly.
 */
public final class TemplateConstants {

    private TemplateConstants() {}

    // --- Type + subtypes ---
    public static final String TYPE_TEMPLATE = "template";
    public static final String SUBTYPE_BASE = "base";
    public static final String SUBTYPE_PROMPT = "prompt";
    public static final String SUBTYPE_OUTPUT = "output";
    /**
     * LLM tool-call envelope subtype (ADR-0011). Does NOT inherit the
     * generic prompt/output attrs — declares its own minimal set
     * ({@code @toolName} required, {@code @payloadRef} required, plus
     * governance {@code @owner} / {@code @since}). No {@code @textRef}
     * requirement: a tool-call has no renderable text body.
     */
    public static final String SUBTYPE_TOOLCALL = "toolcall";

    // --- Generic attributes (prompt + output; NOT inherited by toolcall) ---
    public static final String ATTR_PAYLOAD_REF = "payloadRef";
    public static final String ATTR_TEXT_REF = "textRef";
    public static final String ATTR_FORMAT = "format";
    public static final String ATTR_MAX_CHARS = "maxChars";
    public static final String ATTR_OWNER = "owner";
    public static final String ATTR_SINCE = "since";
    public static final String ATTR_REQUIRED_TAGS = "requiredTags";

    // --- Prompt-overlay attributes (template.prompt only) ---
    public static final String ATTR_MAX_TOKENS = "maxTokens";
    public static final String ATTR_REQUIRED_SLOTS = "requiredSlots";
    public static final String ATTR_MODEL = "model";

    // --- Toolcall-specific attributes (template.toolcall only — ADR-0011) ---
    //
    // Vendor-agnostic in core; vendor wire details (retry semantics, fallback
    // shapes, parallel invocation, cache hints) are added by consumer providers
    // — the cross-port equivalent of TypeScript's registry.extend.
    //
    // @description is intentionally NOT a toolcall-specific constant — every type
    // gets @description via the documentation common-attrs provider. Tool
    // descriptions surfaced to the LLM use the same @description common attr
    // doc-gen uses.
    public static final String ATTR_TOOL_NAME = "toolName";

    // --- @format closed value set ---
    public static final String FORMAT_TEXT = "text";
    public static final String FORMAT_HTML = "html";
    public static final String FORMAT_XML = "xml";
    public static final String FORMAT_CSV = "csv";
    public static final String FORMAT_JSON = "json";
    public static final String FORMAT_MARKDOWN = "markdown";
    public static final String FORMAT_SPREADSHEET = "spreadsheet";

    public static final String FORMAT_DEFAULT = FORMAT_TEXT;

    /**
     * Closed set of valid {@code @format} values. Used by
     * {@code ValidationPhase#validateTemplates} for enum-membership enforcement.
     * Must match the TS / C# format vocabulary exactly (Tier-1 invariant).
     */
    public static final Set<String> ALLOWED_FORMATS = Set.of(
        FORMAT_TEXT, FORMAT_HTML, FORMAT_XML, FORMAT_CSV,
        FORMAT_JSON, FORMAT_MARKDOWN, FORMAT_SPREADSHEET);

    // --- @promptStyle (template.output only — FR-010) ---

    /**
     * Attribute name for the output-format prompt fragment layout style.
     * Only valid on {@code template.output}. Closed enum: see {@link #ALLOWED_PROMPT_STYLES}.
     */
    public static final String ATTR_PROMPT_STYLE = "promptStyle";

    public static final String PROMPT_STYLE_GUIDE = "guide";
    public static final String PROMPT_STYLE_INLINE = "inline";
    public static final String PROMPT_STYLE_EXAMPLE_ONLY = "exampleOnly";

    /** Default value for {@code @promptStyle} when absent. */
    public static final String PROMPT_STYLE_DEFAULT = PROMPT_STYLE_GUIDE;

    /**
     * Closed set of valid {@code @promptStyle} values (FR-010).
     * Enforced by {@code ValidationPhase#validateTemplates} in the same post-load
     * pass that enforces {@code @format}.
     */
    public static final Set<String> ALLOWED_PROMPT_STYLES = Set.of(
        PROMPT_STYLE_GUIDE, PROMPT_STYLE_INLINE, PROMPT_STYLE_EXAMPLE_ONLY);
}
