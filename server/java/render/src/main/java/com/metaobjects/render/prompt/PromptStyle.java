package com.metaobjects.render.prompt;

public enum PromptStyle { GUIDE, INLINE, EXAMPLE_ONLY;
    public static PromptStyle from(String s) {
        if (s == null) return GUIDE;
        return switch (s) { case "inline" -> INLINE; case "exampleOnly" -> EXAMPLE_ONLY; default -> GUIDE; };
    }
}
