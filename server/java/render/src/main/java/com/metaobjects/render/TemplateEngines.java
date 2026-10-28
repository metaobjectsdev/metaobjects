package com.metaobjects.render;

import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;

/**
 * Which template engines this port renders (ADR-0061). Mustache is the cross-port engine
 * and the only one the JVM ports (Java and Kotlin) ship. Jinja is a second engine that only
 * the Python and TypeScript ports render, chosen there by a {@code .jinja} / {@code .j2} /
 * {@code .jinja2} file extension. A provider here that meets a body written for Jinja refuses
 * it with {@link #ERR_TEMPLATE_ENGINE_UNSUPPORTED} rather than rendering it as Mustache (it
 * would print the {@code {%...%}} tags verbatim) or reporting the ref as missing.
 */
public final class TemplateEngines {

    /** The diagnostic code for a template body written for an engine this port does not ship. */
    public static final String ERR_TEMPLATE_ENGINE_UNSUPPORTED = "ERR_TEMPLATE_ENGINE_UNSUPPORTED";

    /** File extensions that mark a body as Jinja, in the Python and TypeScript lookup order. */
    public static final List<String> JINJA_EXTENSIONS = List.of(".jinja", ".j2", ".jinja2");

    private TemplateEngines() {}

    /** True when {@code extension} (with its leading dot) marks a Jinja body. */
    public static boolean isJinjaExtension(String extension) {
        return JINJA_EXTENSIONS.contains(extension.toLowerCase(Locale.ROOT));
    }

    /** True when {@code e} is this refusal (its message starts with the code). */
    public static boolean isEngineRefusal(RenderException e) {
        return e.getMessage() != null && e.getMessage().startsWith(ERR_TEMPLATE_ENGINE_UNSUPPORTED);
    }

    /** Refuse a provider configured to read Jinja files. */
    static void refuseJinjaExtension(String extension) {
        if (isJinjaExtension(extension)) {
            throw new RenderException(ERR_TEMPLATE_ENGINE_UNSUPPORTED + ": " + extension
                + " templates are Jinja, which only the Python and TypeScript ports render (ADR-0061)");
        }
    }

    /**
     * Called when {@code reference} has no Mustache body: throw when a Jinja body exists for it
     * ({@code exists} answers for a candidate suffix), so the author learns why it did not load.
     */
    static void refuseJinjaSibling(String reference, Predicate<String> exists) {
        for (String ext : JINJA_EXTENSIONS) {
            if (exists.test(ext)) {
                throw new RenderException(ERR_TEMPLATE_ENGINE_UNSUPPORTED + ": " + reference + ext
                    + " is a Jinja template; the Java and Kotlin ports render Mustache only (ADR-0061)."
                    + " Rewrite it as " + reference + ".mustache, or render it from the Python or TypeScript port.");
            }
        }
    }
}
