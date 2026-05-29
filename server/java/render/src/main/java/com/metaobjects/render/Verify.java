package com.metaobjects.render;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Template-side drift check (FR-004 Plan #3) — the build-time half of the
 * "renamed field can't silently break a prompt" guarantee. Payload-VO codegen
 * types the payload at the CALL SITE (compile-time); {@code Verify} parses the
 * opaque Mustache template TEXT and cross-checks every variable against the
 * payload's declared field tree (build-time).
 *
 * <p>Zero core dependency by design: {@code Verify} takes a PLAIN field tree
 * (no metadata import). The codegen/CLI derives that tree from the loaded
 * {@code object.value} and passes it in — keeping this engine a standalone,
 * byte-portable module.
 *
 * <p>Faithful port of {@code server/csharp/MetaObjects.Render/Verify.cs} and
 * {@code server/typescript/packages/render/src/verify.ts}; the token model is a
 * small purpose-built Mustache tag tokenizer (verify needs tag structure, not
 * rendering/whitespace).
 */
public final class Verify {

    /** A {@code {{var}}} references a field the (contextual) payload does not declare. */
    public static final String ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD";
    /** A {@code {{> ref}}} partial does not resolve in the provider. */
    public static final String ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED";
    /** A declared {@code @requiredSlots} slot is never referenced by the template (warning). */
    public static final String ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED";
    /** A declared {@code @requiredTags} output tag is absent from the template text. */
    public static final String ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING";
    /** A required field name is absent from the rendered output-format fragment. */
    public static final String ERR_OUTPUT_PROMPT_FIELD_MISSING = "ERR_OUTPUT_PROMPT_FIELD_MISSING";

    static final int MAX_DEPTH = 32;

    private Verify() {}

    // ---------------- Public API (output-prompt coverage) ----------------

    /**
     * Check that every required field name appears (as a substring) in the rendered
     * output-format fragment. The check is a simple substring scan — field names are
     * plain identifiers, so occurrence anywhere in the fragment is sufficient evidence
     * that the renderer included the field.
     *
     * @param fragment        the rendered output-format fragment (XML or JSON skeleton)
     * @param requiredFieldNames the field names that must appear in the fragment
     * @return a list of {@link VerifyError} with code {@link #ERR_OUTPUT_PROMPT_FIELD_MISSING}
     *         for every field name absent from the fragment; empty when all are present
     */
    public static List<VerifyError> checkOutputPrompt(String fragment, List<String> requiredFieldNames) {
        List<VerifyError> errors = new ArrayList<>();
        if (requiredFieldNames == null) return errors;
        String haystack = fragment == null ? "" : fragment;
        for (String name : requiredFieldNames) {
            if (!haystack.contains(name)) {
                errors.add(new VerifyError(ERR_OUTPUT_PROMPT_FIELD_MISSING, name));
            }
        }
        return errors;
    }

    // ---------------- Mustache tag token model (rendering-agnostic) ----------------

    sealed interface Tok permits VarTok, SectionTok, PartialTok {}

    record VarTok(String value) implements Tok {}

    record SectionTok(String value, boolean inverted, List<Tok> children) implements Tok {}

    record PartialTok(String value) implements Tok {}

    // ---------------- Public API ----------------

    /**
     * Walk a Mustache template's tokens against a payload field tree, returning
     * drift errors. Context-sensitive: a section {@code {{#posts}}…{{/posts}}}
     * over a container field checks its body against that field's element type.
     */
    public static List<VerifyError> check(
            String templateText,
            List<PayloadField> fields,
            VerifyOptions options
    ) {
        List<VerifyError> errors = new ArrayList<>();
        VerifyOptions opts = options != null ? options : VerifyOptions.empty();
        Provider provider = opts.provider();
        List<PayloadField> root = fields != null ? fields : List.of();
        Set<String> referencedAtRoot = new LinkedHashSet<>();
        // The static text the output-tag check scans: the body plus every
        // provider-resolved partial body, collected during the single walk below.
        List<String> staticTexts = new ArrayList<>();
        staticTexts.add(templateText);

        WalkContext ctx = new WalkContext(provider, root, errors, referencedAtRoot, staticTexts);
        walk(tokenize(templateText), List.of(root), List.of(), ctx);

        if (opts.requiredSlots() != null) {
            for (String slot : opts.requiredSlots()) {
                if (!referencedAtRoot.contains(slot)) {
                    errors.add(new VerifyError(ERR_REQUIRED_SLOT_UNUSED, slot));
                }
            }
        }

        if (opts.requiredTags() != null && !opts.requiredTags().isEmpty()) {
            // Scan body + resolved partials as one joined string: open and close
            // forms are located independently, so a tag may legitimately straddle
            // the boundary. The "\n" separator only blocks a spurious tag spliced
            // together from two fragments (a real tag is always contiguous within
            // one body).
            String haystack = String.join("\n", staticTexts);
            for (String tag : opts.requiredTags()) {
                if (!hasOpenTag(haystack, tag) || !hasCloseTag(haystack, tag)) {
                    errors.add(new VerifyError(ERR_OUTPUT_TAG_MISSING, tag));
                }
            }
        }

        return errors;
    }

    // ---------------- Walk ----------------

    private record WalkContext(
        Provider provider,
        List<PayloadField> root,
        List<VerifyError> errors,
        Set<String> referencedAtRoot,
        List<String> staticTexts
    ) {}

    private static void walk(
            List<Tok> tokens,
            List<List<PayloadField>> stack,
            List<String> seen,
            WalkContext ctx
    ) {
        boolean atRoot = stack.size() == 1 && stack.get(0) == ctx.root();
        for (Tok tok : tokens) {
            switch (tok) {
                case VarTok v -> {
                    if (".".equals(v.value())) break;   // implicit iterator — always valid
                    if (atRoot) ctx.referencedAtRoot().add(v.value().split("\\.")[0]);
                    if (resolve(stack, v.value()) == null) {
                        ctx.errors().add(new VerifyError(ERR_VAR_NOT_ON_PAYLOAD, v.value()));
                    }
                }
                case SectionTok s -> {
                    if (".".equals(s.value())) {
                        walk(s.children(), stack, seen, ctx);
                        break;
                    }
                    if (atRoot) ctx.referencedAtRoot().add(s.value().split("\\.")[0]);
                    PayloadField field = resolve(stack, s.value());
                    if (field == null) {
                        // Unresolved section head is itself drift; skip the body
                        // (its context is unknowable; walking it cascades false errors).
                        ctx.errors().add(new VerifyError(ERR_VAR_NOT_ON_PAYLOAD, s.value()));
                        break;
                    }
                    // `#` over a container pushes its element fields; `^` (and `#`
                    // over a scalar, used as a conditional) keep the current context.
                    boolean push = !s.inverted() && field.fields() != null;
                    if (push) {
                        List<List<PayloadField>> next = new ArrayList<>(stack);
                        next.add(field.fields());
                        walk(s.children(), Collections.unmodifiableList(next), seen, ctx);
                    } else {
                        walk(s.children(), stack, seen, ctx);
                    }
                }
                case PartialTok p -> {
                    if (ctx.provider() == null) break;   // can't resolve without a provider
                    if (seen.contains(p.value()) || seen.size() >= MAX_DEPTH) break;
                    String text = ctx.provider().resolve(p.value());
                    if (text == null) {
                        ctx.errors().add(new VerifyError(ERR_PARTIAL_UNRESOLVED, p.value()));
                        break;
                    }
                    ctx.staticTexts().add(text);
                    List<String> nextSeen = new ArrayList<>(seen);
                    nextSeen.add(p.value());
                    walk(tokenize(text), stack, Collections.unmodifiableList(nextSeen), ctx);
                }
            }
        }
    }

    // ---------------- Field-tree lookup (Mustache context-stack semantics) ----------------

    private static PayloadField find(List<PayloadField> fields, String name) {
        for (PayloadField f : fields) {
            if (f.name().equals(name)) return f;
        }
        return null;
    }

    /**
     * Resolve a (possibly dotted) path the way Mustache does: the FIRST segment
     * is looked up through the context stack (innermost → outermost); each
     * remaining segment descends into the resolved field's {@code fields}.
     * Returns {@code null} when any segment is missing.
     */
    private static PayloadField resolve(List<List<PayloadField>> stack, String path) {
        String[] segs = path.split("\\.");
        PayloadField current = null;
        for (int i = stack.size() - 1; i >= 0; i--) {
            PayloadField hit = find(stack.get(i), segs[0]);
            if (hit != null) { current = hit; break; }
        }
        for (int i = 1; current != null && i < segs.length; i++) {
            current = current.fields() != null ? find(current.fields(), segs[i]) : null;
        }
        return current;
    }

    // ---------------- Tokenizer ----------------

    /**
     * Tokenize a Mustache template body into the small subset {@code Verify}
     * cares about: variables (incl. {@code {{&x}}} and {@code {{{x}}}}),
     * sections + inverted sections (with nested children), and partials.
     * Comments and set-delimiter changes are dropped; plain text is skipped.
     */
    static List<Tok> tokenize(String text) {
        int[] pos = {0};
        return parseTokens(text, pos);
    }

    /**
     * Parse tokens until EOF or a matching {@code {{/...}}} (which is consumed).
     * Mirrors C# {@code Verify.cs ParseTokens()} — note that any close tag
     * (matched or mismatched) ends the current level, which is intentionally
     * lenient (templates that drift to imbalanced sections still tokenize).
     */
    private static List<Tok> parseTokens(String text, int[] pos) {
        List<Tok> tokens = new ArrayList<>();
        while (pos[0] < text.length()) {
            int open = text.indexOf("{{", pos[0]);
            if (open < 0) break;   // remainder is plain text
            boolean triple = open + 2 < text.length() && text.charAt(open + 2) == '{';
            String closeDelim = triple ? "}}}" : "}}";
            int contentStart = open + (triple ? 3 : 2);
            int close = text.indexOf(closeDelim, contentStart);
            if (close < 0) break;  // malformed; stop
            String content = text.substring(contentStart, close).trim();
            pos[0] = close + closeDelim.length();

            if (triple) {
                tokens.add(new VarTok(content));
                continue;
            }
            if (content.isEmpty()) continue;

            char sigil = content.charAt(0);
            String name = content.length() > 1 ? content.substring(1).trim() : "";
            switch (sigil) {
                case '!':
                    break;   // comment
                case '#':
                case '^':
                    List<Tok> children = parseTokens(text, pos);
                    tokens.add(new SectionTok(name, sigil == '^', children));
                    break;
                case '/':
                    return tokens;   // close (matched or mismatched) ends this level
                case '>':
                    tokens.add(new PartialTok(name));
                    break;
                case '&':
                    tokens.add(new VarTok(name));
                    break;
                default:
                    tokens.add(new VarTok(content));   // {{x}}, {{x.y}}, {{.}}
                    break;
            }
        }
        return tokens;
    }

    // ---------------- Required-tag matching ----------------

    // An opening tag is `<tag` immediately followed by `>` or XML whitespace,
    // so attributes are allowed (`<answer foo="1">`) but a longer name is not
    // over-matched (`<answers>` does not satisfy `answer`).
    private static boolean isTagOpenDelim(char c) {
        return c == '>' || c == ' ' || c == '\t' || c == '\n' || c == '\r';
    }

    static boolean hasOpenTag(String text, String tag) {
        String needle = "<" + tag;
        int i = text.indexOf(needle);
        while (i >= 0) {
            int after = i + needle.length();
            if (after < text.length() && isTagOpenDelim(text.charAt(after))) return true;
            i = text.indexOf(needle, i + 1);
        }
        return false;
    }

    // A closing tag is the exact literal `</tag>`. A self-closing `<tag/>` has
    // no such form, so it never satisfies a required tag — these wrap content
    // a parser reads.
    static boolean hasCloseTag(String text, String tag) {
        return text.contains("</" + tag + ">");
    }
}
