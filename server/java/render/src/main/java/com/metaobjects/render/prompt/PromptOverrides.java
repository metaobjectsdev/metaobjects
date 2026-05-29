package com.metaobjects.render.prompt;

import java.util.Map;

/** Render-time overrides of the metadata defaults. style null = keep spec's; maps override per field name. */
public record PromptOverrides(PromptStyle style, Map<String, String> examples, Map<String, String> instructions) {
    public PromptOverrides {
        examples = examples == null ? Map.of() : Map.copyOf(examples);
        instructions = instructions == null ? Map.of() : Map.copyOf(instructions);
    }
    public static PromptOverrides none() { return new PromptOverrides(null, Map.of(), Map.of()); }
}
