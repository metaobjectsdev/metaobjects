package com.metaobjects.render;

import com.github.mustachejava.DefaultMustacheFactory;
import com.github.mustachejava.Mustache;
import com.github.mustachejava.DefaultMustacheVisitor;
import com.github.mustachejava.MustacheException;
import com.github.mustachejava.MustacheVisitor;
import com.github.mustachejava.TemplateContext;
import com.github.mustachejava.codes.ValueCode;
import com.github.mustachejava.reflect.Guard;
import com.github.mustachejava.reflect.MissingWrapper;
import com.github.mustachejava.reflect.ReflectionObjectHandler;
import com.github.mustachejava.util.GuardException;
import com.github.mustachejava.util.Wrapper;

import java.io.IOException;
import java.io.StringReader;
import java.io.StringWriter;
import java.io.Writer;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.function.Function;

/**
 * Mustache-driven render pipeline for the {@code template.*} metatype (FR-004).
 *
 * <p>Pipeline: resolve template text (inline or via provider) → verify it against the
 * request's payload field tree when one is given → pre-expand
 * partials by recursive inlining (cycle-guarded, MAX_DEPTH=32) →
 * Mustache.java compile + execute (HTML escaping DISABLED on the factory
 * because the {@link Escapers} layer owns escaping) → apply format-keyed
 * escaper → fail-closed if the result exceeds {@code maxChars} (THROWS, never
 * truncates).
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

    public String render(RenderRequest req) {
        validate(req);

        String body = req.template() != null
            ? req.template()
            : resolveOrThrow(req.provider(), req.ref());

        // Drift guard: when the request carries the payload field tree, the RESOLVED body is
        // verified against it before it renders, so `{{nmae}}` for `name` raises instead of
        // rendering empty. A warning-level result (a declared required slot the body never
        // uses) is not drift. Matches TS render.ts and C# Renderer.Render.
        if (req.verify() != null) {
            List<VerifyError> drift = Verify.check(body, req.verify(), new VerifyOptions(req.provider(), null, null))
                .stream()
                .filter(e -> !Verify.ERR_REQUIRED_SLOT_UNUSED.equals(e.code()))
                .toList();
            if (!drift.isEmpty()) {
                throw new RenderException("render verify failed: " + drift.stream()
                    .map(e -> e.code() + " (" + e.path() + ")")
                    .collect(java.util.stream.Collectors.joining(", ")));
            }
        }

        String expanded = preExpandPartials(body, req.provider(), new ArrayDeque<>());
        try {
            expanded = MustacheTags.withoutStandaloneComments(expanded);
        } catch (MustacheTags.SyntaxException e) {
            throw new RenderException("template syntax error: " + e.getMessage());
        }

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
                public MustacheVisitor createMustacheVisitor() {
                    return new DefaultMustacheVisitor(this) {
                        @Override
                        public void value(TemplateContext tc, String variable, boolean encoded) {
                            list.add(new CheckedValueCode(tc, this.df, variable, encoded));
                        }
                    };
                }

                @Override
                public void encode(String value, Writer writer) {
                    try {
                        writer.write(escaper.apply(value));
                    } catch (IOException e) {
                        throw new MustacheException(e);
                    }
                }
            };
            factory.setObjectHandler(new MissingVariableObjectHandler());
            Mustache compiled = factory.compile(new StringReader(expanded), refOrInline(req));
            StringWriter writer = new StringWriter();
            // Derived `has<Field>` accessors are part of the payload contract, not of the
            // caller's object — see PayloadAccessors. A generated record already answers
            // hasFoo(); this fills the same contract for a map-shaped payload, so the two
            // render identically.
            compiled.execute(writer, PayloadAccessors.withDerivedAccessors(req.payload())).flush();
            rendered = writer.toString();
        } catch (MustacheException | IOException e) {
            // A missing variable is raised from inside the engine, which wraps it; surface it as is.
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof RenderException re) throw re;
            }
            throw new RenderException("Mustache compile/execute failed", e);
        }

        // @maxChars is a fail-closed render budget: over-budget output THROWS
        // (never silently truncates). Canonical cross-port behavior — message
        // shape matches TS/C#/Python: "render exceeded maxChars budget: <len> > <cap>".
        if (req.maxChars() != null && rendered.length() > req.maxChars()) {
            throw new RenderException(
                "render exceeded maxChars budget: " + rendered.length() + " > " + req.maxChars());
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

        // Partial tags are located by the shared scanner, so one written inside a comment
        // is not a partial and a {{=<% %>=}} delimiter change is honoured.
        List<MustacheTags.Tag> tags;
        try {
            tags = MustacheTags.scan(text);
        } catch (MustacheTags.SyntaxException e) {
            throw new RenderException("template syntax error: " + e.getMessage());
        }
        if (MustacheTags.delimiterConflict(tags, stack.peek()) != null) {
            throw new RenderException(
                "a template that uses partials cannot also change delimiters ({{=<% %>=}})");
        }
        List<MustacheTags.Tag> partials = tags.stream()
            .filter(t -> t.kind() == MustacheTags.Kind.PARTIAL).toList();
        if (partials.isEmpty()) return text;

        StringBuilder out = new StringBuilder(text.length());
        int last = 0;
        for (MustacheTags.Tag tag : partials) {
            String partialRef = tag.value();
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

            out.append(text, last, tag.start());
            out.append(expanded);
            last = tag.end();
        }
        out.append(text, last, text.length());
        return out.toString();
    }

    /**
     * Marks a name that is on no scope of the payload. A key present with a null value is NOT
     * missing (it renders empty); only an absent name is.
     */
    private static final class AbsentWrapper extends MissingWrapper {
        AbsentWrapper(String name, Guard[] guards) {
            super(name, guards);
        }
    }

    private static final class MissingVariableObjectHandler extends ReflectionObjectHandler {
        @Override
        protected MissingWrapper createMissingWrapper(String name, List<Guard> guards) {
            return new AbsentWrapper(name, guards.toArray(new Guard[0]));
        }
    }

    /**
     * A variable tag whose name is absent from the payload raises, with the message the opt-in
     * verify gate uses, so a typo like {@code {{nmae}}} fails on every render path. Section tags
     * stay silent: an absent section is simply falsy.
     */
    private static final class CheckedValueCode extends ValueCode {
        CheckedValueCode(TemplateContext tc, DefaultMustacheFactory df, String variable, boolean encoded) {
            super(tc, df, variable, encoded);
        }

        @Override
        public Writer execute(Writer writer, List<Object> scopes) {
            if (!returnThis && oh.find(name, scopes) instanceof AbsentWrapper && !presentWholePath(scopes)) {
                throw new RenderException(
                    "render verify failed: " + Verify.ERR_VAR_NOT_ON_PAYLOAD + " (" + name + ")");
            }
            return super.execute(writer, scopes);
        }

        /**
         * The reference check (TypeScript on mustache.js) tries the WHOLE dotted name against each
         * context from the innermost outward, and reads a list's {@code length} as a property. The
         * engine's own lookup stops at the first context holding the first segment, so without this
         * a name TypeScript renders (a shadowed prefix, {@code items.length}) would raise here.
         */
        /** The list property JavaScript exposes, and the reference check therefore treats as present. */
        private static final String LENGTH_PROPERTY = "length";

        private boolean presentWholePath(List<Object> scopes) {
            int dot = name.lastIndexOf('.');
            String listName = dot > 0 && LENGTH_PROPERTY.equals(name.substring(dot + 1)) ? name.substring(0, dot) : null;
            for (int i = scopes.size() - 1; i >= 0; i--) {
                List<Object> one = Collections.singletonList(scopes.get(i));
                if (!(oh.find(name, one) instanceof AbsentWrapper)) return true;
                if (listName == null) continue;
                Wrapper w = oh.find(listName, one);
                if (w instanceof AbsentWrapper) continue;
                try {
                    Object v = w.call(one);
                    if (v instanceof Collection<?> || (v != null && v.getClass().isArray())) return true;
                } catch (GuardException e) {
                    // not resolvable on this context; try the next one out
                }
            }
            return false;
        }
    }
}
