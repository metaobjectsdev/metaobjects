package com.metaobjects.render;

import com.github.mustachejava.DefaultMustacheFactory;
import com.github.mustachejava.Mustache;
import com.github.mustachejava.MustacheException;

import java.io.IOException;
import java.io.StringReader;
import java.io.StringWriter;
import java.io.Writer;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Mustache-driven render pipeline for the {@code template.*} metatype (FR-004).
 *
 * <p>Pipeline: resolve template text (inline or via provider) → pre-expand
 * partials by recursive inlining (cycle-guarded, MAX_DEPTH=32) →
 * Mustache.java compile + execute (HTML escaping DISABLED on the factory
 * because the {@link Escapers} layer owns escaping) → apply format-keyed
 * escaper → truncate to {@code maxChars} if set.
 *
 * <p>Pre-expanding partials before Mustache compile guarantees deterministic
 * cross-port whitespace (matches TS + C#) and lets the engine own cycle
 * detection independent of the library.
 *
 * <p>Mirrors {@code server/csharp/MetaObjects.Render/Renderer.cs} and
 * {@code server/typescript/packages/render/src/render.ts}.
 */
public final class Renderer {

    static final int MAX_DEPTH = 32;

    // {{> name }} — captures the reference between the marker and the closing }}.
    private static final Pattern PARTIAL_PATTERN =
        Pattern.compile("\\{\\{>\\s*([^\\s}]+)\\s*\\}\\}");

    public String render(RenderRequest req) {
        validate(req);

        String body = req.template() != null
            ? req.template()
            : resolveOrThrow(req.provider(), req.ref());

        String expanded = preExpandPartials(body, req.provider(), new ArrayDeque<>());

        // Per-variable escaping via the Mustache encode() hook — equivalent to
        // C# Stubble's SetEncodingFunction. {{var}} runs through the escaper,
        // {{{var}}} bypasses it (raw form), and literal template text passes
        // through unmodified.
        String format = req.format() != null ? req.format() : Escapers.FORMAT_TEXT;
        Function<String, String> escaper = v -> Escapers.escape(format, v);

        String rendered;
        try {
            DefaultMustacheFactory factory = new DefaultMustacheFactory() {
                @Override
                public void encode(String value, Writer writer) {
                    try {
                        writer.write(escaper.apply(value));
                    } catch (IOException e) {
                        throw new MustacheException(e);
                    }
                }
            };
            Mustache compiled = factory.compile(new StringReader(expanded), refOrInline(req));
            StringWriter writer = new StringWriter();
            compiled.execute(writer, req.payload()).flush();
            rendered = writer.toString();
        } catch (MustacheException | IOException e) {
            throw new RenderException("Mustache compile/execute failed", e);
        }

        if (req.maxChars() != null && rendered.length() > req.maxChars()) {
            rendered = rendered.substring(0, req.maxChars());
        }
        return rendered;
    }

    private static void validate(RenderRequest req) {
        if (req.provider() == null) {
            throw new RenderException("RenderRequest.provider is required");
        }
        if (req.payload() == null) {
            throw new RenderException("RenderRequest.payload is required");
        }
        if (req.template() == null && req.ref() == null) {
            throw new RenderException("RenderRequest must set either template or ref");
        }
        if (req.template() != null && req.ref() != null) {
            throw new RenderException("RenderRequest must set template OR ref, not both");
        }
    }

    private static String resolveOrThrow(Provider provider, String ref) {
        String text = provider.resolve(ref);
        if (text == null) {
            throw new RenderException("unresolved ref: " + ref);
        }
        return text;
    }

    private static String refOrInline(RenderRequest req) {
        return req.ref() != null ? req.ref() : "<inline>";
    }

    private static String preExpandPartials(String text, Provider provider, Deque<String> stack) {
        if (stack.size() >= MAX_DEPTH) {
            throw new RenderException("partial depth exceeded " + MAX_DEPTH
                + " (chain: " + String.join(" -> ", stack) + ")");
        }

        Matcher m = PARTIAL_PATTERN.matcher(text);
        if (!m.find()) return text;
        m.reset();

        StringBuilder out = new StringBuilder(text.length());
        int last = 0;
        while (m.find()) {
            String partialRef = m.group(1);
            if (stack.contains(partialRef)) {
                throw new RenderException("partial cycle: "
                    + String.join(" -> ", stack) + " -> " + partialRef);
            }

            String partialText = provider.resolve(partialRef);
            if (partialText == null) {
                throw new RenderException("unresolved partial: " + partialRef);
            }

            stack.push(partialRef);
            String expanded = preExpandPartials(partialText, provider, stack);
            stack.pop();

            out.append(text, last, m.start());
            out.append(expanded);
            last = m.end();
        }
        out.append(text, last, text.length());
        return out.toString();
    }
}
