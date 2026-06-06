"""Template subtype vocabulary (FR-004 cross-language prompt construction)."""
from ...shared.base_types import SUBTYPE_BASE

TEMPLATE_SUBTYPE_PROMPT = "prompt"
TEMPLATE_SUBTYPE_OUTPUT = "output"
# template.toolcall — ADR-0011: LLM tool-call envelope (no renderable body —
# the body IS the structured output schema resolved via @payloadRef).
TEMPLATE_SUBTYPE_TOOLCALL = "toolcall"
TEMPLATE_SUBTYPES = (
    SUBTYPE_BASE,
    TEMPLATE_SUBTYPE_PROMPT,
    TEMPLATE_SUBTYPE_OUTPUT,
    TEMPLATE_SUBTYPE_TOOLCALL,
)

# Shared attrs across template.prompt and template.output (NOT inherited by
# template.toolcall — see ADR-0011).
TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef"
TEMPLATE_ATTR_TEXT_REF = "textRef"
TEMPLATE_ATTR_FORMAT = "format"
TEMPLATE_ATTR_MAX_CHARS = "maxChars"
TEMPLATE_ATTR_OWNER = "owner"
TEMPLATE_ATTR_SINCE = "since"
TEMPLATE_ATTR_REQUIRED_TAGS = "requiredTags"

# --- @kind + email part-refs (template.output only) ---
#
# A template.output is either a plain document (renders @textRef in @format ->
# one string) or an email (renders subject + html + optional text -> a
# structured EmailDocument). @kind is a closed enum; the email part-refs are
# 2-layer logical (group/source) textRefs resolved by a provider at render time.
# Cross-field rules live in validation_passes._validate_templates:
#   - @kind="email"            -> require @subjectRef AND @htmlBodyRef (textRef unused; @textBodyRef optional)
#   - @kind="document"/absent  -> require @textRef
# Must match TS / Java exactly (Tier-1 invariant).
TEMPLATE_ATTR_KIND = "kind"
TEMPLATE_KIND_DOCUMENT = "document"
TEMPLATE_KIND_EMAIL = "email"
TEMPLATE_KIND_DEFAULT = TEMPLATE_KIND_DOCUMENT
ALLOWED_KINDS = (
    TEMPLATE_KIND_DOCUMENT,
    TEMPLATE_KIND_EMAIL,
)

TEMPLATE_ATTR_SUBJECT_REF = "subjectRef"
TEMPLATE_ATTR_HTML_BODY_REF = "htmlBodyRef"
TEMPLATE_ATTR_TEXT_BODY_REF = "textBodyRef"

# Prompt-overlay attrs (template.prompt only).
TEMPLATE_ATTR_MAX_TOKENS = "maxTokens"
TEMPLATE_ATTR_REQUIRED_SLOTS = "requiredSlots"
TEMPLATE_ATTR_MODEL = "model"
# @responseRef — peer of @payloadRef on template.prompt ONLY (NOT shared, NOT on
# template.output): names the typed VO an LLM RESPONSE is extracted into, driving
# the derived voResponse jsonb trace column (AI LLM-call trace persistence).
# TS-pilot vocabulary — carved out of the cross-port registry manifest
# (registry_manifest.ExclusionReason.TS_PILOT_VOCAB) until promoted to all ports.
TEMPLATE_ATTR_RESPONSE_REF = "responseRef"

# Toolcall-specific attrs (template.toolcall only — see ADR-0011).
# Vendor-agnostic in core; vendor wire details (retry semantics, fallback
# shapes, parallel invocation, cache hints) added by consumer providers via
# registry.extend("template", "toolcall", attributes=[...]).
#
# @description is intentionally NOT declared here — it's already a documentation
# common attr added to every type by the doc provider. Tool descriptions
# surfaced to the LLM read the same @description common attr.
#
# @textRef is intentionally NOT required — a tool-call has no renderable text
# body. The body IS the structured output schema resolved via @payloadRef.
TEMPLATE_ATTR_TOOL_NAME = "toolName"

# Closed-set values for @format. Cross-port invariant.
TEMPLATE_FORMAT_TEXT = "text"
TEMPLATE_FORMAT_HTML = "html"
TEMPLATE_FORMAT_XML = "xml"
TEMPLATE_FORMAT_CSV = "csv"
TEMPLATE_FORMAT_JSON = "json"
TEMPLATE_FORMAT_MARKDOWN = "markdown"
TEMPLATE_FORMAT_SPREADSHEET = "spreadsheet"
ALLOWED_FORMATS = (
    TEMPLATE_FORMAT_TEXT,
    TEMPLATE_FORMAT_HTML,
    TEMPLATE_FORMAT_XML,
    TEMPLATE_FORMAT_CSV,
    TEMPLATE_FORMAT_JSON,
    TEMPLATE_FORMAT_MARKDOWN,
    TEMPLATE_FORMAT_SPREADSHEET,
)
TEMPLATE_FORMAT_DEFAULT = TEMPLATE_FORMAT_TEXT

# FR-010 artifact-1: output-format prompt presentation style (template.output only).
# Closed enum, enforced via allowed_values exactly like @format. Default "guide".
# Guidance is NEVER carried in comments. Set project-wide via an abstract template
# base + extends, with a render-time PromptOverrides.style on top.
TEMPLATE_ATTR_PROMPT_STYLE = "promptStyle"
PROMPT_STYLE_GUIDE = "guide"
PROMPT_STYLE_INLINE = "inline"
PROMPT_STYLE_EXAMPLE_ONLY = "exampleOnly"
PROMPT_STYLE_DEFAULT = PROMPT_STYLE_GUIDE
PROMPT_STYLES = (
    PROMPT_STYLE_GUIDE,
    PROMPT_STYLE_INLINE,
    PROMPT_STYLE_EXAMPLE_ONLY,
)

# @xmlText — a FIELD-level marker (boolean) for the tolerant extract engine: this field
# receives its element's TEXT CONTENT when a template.output response is parsed from XML
# (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]). Registered on field.* by
# template_provider (the prompt/output domain owns this extract concern — NOT a core field
# property). No effect for @format: json. Mirrors Java TemplateConstants.ATTR_XML_TEXT,
# TS FIELD_ATTR_XML_TEXT, and C# TemplateConstants.ATTR_XML_TEXT.
TEMPLATE_ATTR_XML_TEXT = "xmlText"
