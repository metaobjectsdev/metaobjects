package com.metaobjects.render.prompt;

import com.metaobjects.render.recover.FieldKind;
import java.util.List;
import java.util.Map;

/** enumValues/enumDoc non-null only for ENUM; nested non-null only for OBJECT; example/instruction nullable. */
public record PromptField(String name, FieldKind kind, boolean required, boolean array,
                          List<String> enumValues, Map<String, String> enumDoc,
                          String example, String instruction, OutputFormatSpec nested) {}
