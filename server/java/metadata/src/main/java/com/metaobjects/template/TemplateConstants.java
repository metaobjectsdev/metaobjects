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

    /**
     * {@code @xmlText} — a FIELD-level marker (boolean) for the tolerant extract engine: this
     * field receives its element's TEXT CONTENT when a {@code template.output} response is parsed
     * from XML (analogous to JAXB {@code @XmlValue} / Jackson {@code @JacksonXmlText} / .NET
     * {@code [XmlText]}). On an element that also carries attributes, a marked field reads the text
     * body rather than a same-named child. Registered on {@code field.base} by
     * {@link TemplateTypesMetaDataProvider} (the prompt/output domain owns this extract concern —
     * it is NOT a core field property). No effect for {@code @format: json}.
     */
    public static final String ATTR_XML_TEXT = "xmlText";

    // --- @kind + email part-refs (template.output only) ---
    //
    // A template.output is either a plain document (renders @textRef in @format →
    // one string) or an email (renders subject + html + optional text → a
    // structured EmailDocument). @kind is a closed enum; the email part-refs are
    // 2-layer logical (group/source) textRefs resolved by a provider at render
    // time. Cross-field rules are enforced in ValidationPhase#validateTemplates:
    //   - @kind="email"            → require @subjectRef AND @htmlBodyRef (textRef unused; @textBodyRef optional)
    //   - @kind="document"/absent  → require @textRef
    // Must match TS (packages/metadata/src/template/) exactly (Tier-1 invariant).
    public static final String ATTR_KIND = "kind";
    public static final String KIND_DOCUMENT = "document";
    public static final String KIND_EMAIL = "email";
    public static final String KIND_DEFAULT = KIND_DOCUMENT;

    /**
     * Closed set of valid {@code @kind} values (template.output). Enforced by
     * {@code ValidationPhase#validateTemplates} in the same post-load pass that
     * enforces {@code @format} / {@code @promptStyle}.
     */
    public static final Set<String> ALLOWED_KINDS = Set.of(KIND_DOCUMENT, KIND_EMAIL);

    public static final String ATTR_SUBJECT_REF = "subjectRef";
    public static final String ATTR_HTML_BODY_REF = "htmlBodyRef";
    public static final String ATTR_TEXT_BODY_REF = "textBodyRef";

    // --- Prompt-overlay attributes (template.prompt only) ---
    public static final String ATTR_MAX_TOKENS = "maxTokens";
    public static final String ATTR_REQUIRED_SLOTS = "requiredSlots";
    public static final String ATTR_MODEL = "model";

    /**
     * {@code @responseRef} — optional single-valued string on {@code template.prompt}
     * ONLY (the AI prompt-derived-trace vertical; mirrors TS {@code promptOverlayAttrs}).
     * Names a nested template whose payload VO shapes the LLM-call trace's typed
     * response column. NOT on the shared template base (so it is absent from
     * {@code template.output}). A TS-pilot vocab carved out of the cross-port
     * registry manifest until promoted to all five ports.
     */
    public static final String ATTR_RESPONSE_REF = "responseRef";

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

    // --- @promptStyle (template.prompt only — FR-010, re-homed by ADR-0052) ---

    /**
     * Attribute name for the response-format fragment layout style.
     * Only valid on {@code template.prompt}. Closed enum: see {@link #ALLOWED_PROMPT_STYLES}.
     *
     * <p>ADR-0052 moved this off {@code template.output}: it governs a fragment that
     * instructs an LLM how to format its reply, so hosting it on the subtype defined as
     * "every rendered artifact other than an LLM prompt" was a contradiction visible in
     * the attribute's own description.
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

    // --- @responseFormat (template.prompt only — ADR-0053) ---

    /**
     * Attribute name for the syntax of the model's REPLY. Only valid on
     * {@code template.prompt}. Closed enum: see {@link #ALLOWED_RESPONSE_FORMATS}.
     *
     * <p>Distinct from {@link #ATTR_FORMAT}, which is the syntax of the rendered prompt
     * BODY. The two genuinely differ — a plain-text prompt may elicit an XML reply — which
     * is why one attribute cannot serve both directions.
     */
    public static final String ATTR_RESPONSE_FORMAT = "responseFormat";

    public static final String RESPONSE_FORMAT_JSON = "json";
    public static final String RESPONSE_FORMAT_XML = "xml";

    /**
     * Default value for {@code @responseFormat} when absent. Reproduces the
     * pre-ADR-0053 fallback exactly (anything that was not "xml" was treated as JSON),
     * so the default is behaviour-preserving rather than a new policy.
     */
    public static final String RESPONSE_FORMAT_DEFAULT = RESPONSE_FORMAT_JSON;

    /**
     * Closed set of valid {@code @responseFormat} values (ADR-0053). TWO members, not
     * {@link #ALLOWED_FORMATS}' seven: two is what every shipping consumer dispatches on.
     * The rest are reserved-not-registered under ADR-0007 Amendment 2's re-entry bar —
     * a member enters the registry only when a shipping consumer dispatches on it.
     */
    public static final Set<String> ALLOWED_RESPONSE_FORMATS = Set.of(
        RESPONSE_FORMAT_JSON, RESPONSE_FORMAT_XML);
}
