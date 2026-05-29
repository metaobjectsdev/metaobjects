package com.metaobjects.render.prompt;

import com.metaobjects.render.recover.FieldKind;
import java.util.List;
import java.util.Map;

/**
 * enumValues/enumDoc non-null only for ENUM; nested non-null only for OBJECT; example/instruction nullable.
 * Precondition: {@code name} must be identifier-safe (valid XML element name / JSON key).
 * The renderer does not escape field names.
 */
public record PromptField(String name, FieldKind kind, boolean required, boolean array,
                          List<String> enumValues, Map<String, String> enumDoc,
                          String example, String instruction, OutputFormatSpec nested) {}
