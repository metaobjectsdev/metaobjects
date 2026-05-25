package com.metaobjects.template;

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

    // --- Generic attributes (both subtypes) ---
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

    // --- @format closed value set ---
    public static final String FORMAT_TEXT = "text";
    public static final String FORMAT_HTML = "html";
    public static final String FORMAT_XML = "xml";
    public static final String FORMAT_CSV = "csv";
    public static final String FORMAT_JSON = "json";
    public static final String FORMAT_MARKDOWN = "markdown";
    public static final String FORMAT_SPREADSHEET = "spreadsheet";

    public static final String FORMAT_DEFAULT = FORMAT_TEXT;
}
