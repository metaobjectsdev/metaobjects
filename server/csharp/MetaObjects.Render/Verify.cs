// Template-side drift check (FR-004 Plan #3, T5). The other half of the
// guarantee: payload-VO codegen types the payload at the CALL SITE (compile-time),
// while Verify parses the opaque template TEXT and cross-checks every variable
// against the payload's declared field tree (build-time). A Mustache template is
// a runtime string the compiler can't see into, so this is the only way to catch
// "a renamed field silently broke a prompt".
//
// Zero core dependency by design: Verify takes a PLAIN field tree (no metadata
// import). The codegen/CLI derives that tree from the loaded object.value and
// passes it in. Ported from typescript/packages/render/src/verify.ts; the token
// model is a small purpose-built Mustache tag tokenizer (verify needs tag
// structure, not rendering/whitespace).

namespace MetaObjects.Render;

/// <summary>
/// A plain field-tree node mirroring an <c>object.value</c> view-object's field
/// walk. <see cref="Fields"/> present → a context-pushing field (object /
/// array-of-object); null → a scalar (string/number/boolean/scalar-array).
/// </summary>
public sealed record PayloadField(string Name, IReadOnlyList<PayloadField>? Fields = null);

/// <summary>A single drift finding: a code + the offending var path / partial ref / slot.</summary>
public sealed record VerifyError(string Code, string Path);

/// <summary>Options for <see cref="Verify.Check"/>.</summary>
public sealed record VerifyOptions
{
    /// <summary>When given, <c>{{&gt; ref}}</c> partials are resolved + their bodies recursed.</summary>
    public IProvider? Provider { get; init; }
    /// <summary>Slots that MUST be referenced; an unused one is reported as a warning.</summary>
    public IReadOnlyList<string>? RequiredSlots { get; init; }
    /// <summary>
    /// Output tags the rendered text is contracted to contain. Each must appear as
    /// both an opening form (<c>&lt;tag</c> followed by <c>&gt;</c> or whitespace, so
    /// attributes are allowed) and a closing <c>&lt;/tag&gt;</c> — across the body AND
    /// resolved partials.
    /// </summary>
    public IReadOnlyList<string>? RequiredTags { get; init; }
}

/// <summary>Template-side drift check against a payload field tree.</summary>
public static class Verify
{
    /// <summary>A <c>{{var}}</c> references a field the (contextual) payload does not declare.</summary>
    public const string ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD";
    /// <summary>A <c>{{&gt; ref}}</c> partial does not resolve in the provider.</summary>
    public const string ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED";
    /// <summary>A declared @requiredSlots slot is never referenced by the template (warning).</summary>
    public const string ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED";
    /// <summary>A declared @requiredTags output tag is absent from the template text.</summary>
    public const string ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING";

    private const int MaxDepth = 32;

    // --- Mustache tag token model (rendering-agnostic; only tag structure) ---
    private abstract record Tok;
    private sealed record VarTok(string Value) : Tok;
    private sealed record SectionTok(string Value, bool Inverted, IReadOnlyList<Tok> Children) : Tok;
    private sealed record PartialTok(string Value) : Tok;

    private static List<Tok> Tokenize(string text)
    {
        int pos = 0;
        return ParseTokens(text, ref pos, null);
    }

    // Parse tokens until EOF or a matching {{/closeName}} (which is consumed).
    private static List<Tok> ParseTokens(string text, ref int pos, string? closeName)
    {
        var tokens = new List<Tok>();
        while (pos < text.Length)
        {
            int open = text.IndexOf("{{", pos, StringComparison.Ordinal);
            if (open < 0) break; // remainder is plain text
            bool triple = open + 2 < text.Length && text[open + 2] == '{';
            string closeDelim = triple ? "}}}" : "}}";
            int contentStart = open + (triple ? 3 : 2);
            int close = text.IndexOf(closeDelim, contentStart, StringComparison.Ordinal);
            if (close < 0) break; // malformed; stop
            string content = text[contentStart..close].Trim();
            pos = close + closeDelim.Length;

            if (triple)
            {
                tokens.Add(new VarTok(content));
                continue;
            }
            if (content.Length == 0) continue;

            char sigil = content[0];
            string name = content.Length > 1 ? content[1..].Trim() : "";
            switch (sigil)
            {
                case '!': break; // comment
                case '#':
                case '^':
                    var children = ParseTokens(text, ref pos, name);
                    tokens.Add(new SectionTok(name, sigil == '^', children));
                    break;
                case '/':
                    return tokens; // close (matched or mismatched) ends this level
                case '>':
                    tokens.Add(new PartialTok(name));
                    break;
                case '&':
                    tokens.Add(new VarTok(name));
                    break;
                default:
                    tokens.Add(new VarTok(content)); // {{x}}, {{x.y}}, {{.}}
                    break;
            }
        }
        return tokens;
    }

    private static PayloadField? Find(IReadOnlyList<PayloadField> fields, string name) =>
        fields.FirstOrDefault(f => f.Name == name);

    // Resolve a (possibly dotted) path as Mustache does: the FIRST segment is
    // looked up through the context stack (innermost → outermost); each remaining
    // segment descends into the resolved field's Fields.
    private static PayloadField? Resolve(List<IReadOnlyList<PayloadField>> stack, string path)
    {
        var segs = path.Split('.');
        PayloadField? current = null;
        for (int i = stack.Count - 1; i >= 0; i--)
        {
            var hit = Find(stack[i], segs[0]);
            if (hit is not null) { current = hit; break; }
        }
        for (int i = 1; current is not null && i < segs.Length; i++)
            current = current.Fields is not null ? Find(current.Fields, segs[i]) : null;
        return current;
    }

    /// <summary>
    /// Walk a Mustache template's tokens against a payload field tree, returning
    /// drift errors. Context-sensitive: a section <c>{{#posts}}…{{/posts}}</c> over
    /// a container field checks its body against that field's element type.
    /// </summary>
    public static IReadOnlyList<VerifyError> Check(
        string templateText,
        IReadOnlyList<PayloadField> fields,
        VerifyOptions? options = null)
    {
        var errors = new List<VerifyError>();
        var provider = options?.Provider;
        var root = fields;
        var referencedAtRoot = new HashSet<string>(StringComparer.Ordinal);
        // The static text the output-tag check scans: the body plus every
        // provider-resolved partial body, collected during the single walk below
        // (no second resolution pass).
        var staticTexts = new List<string> { templateText };

        void Walk(IReadOnlyList<Tok> tokens, List<IReadOnlyList<PayloadField>> stack, List<string> seen)
        {
            bool atRoot = stack.Count == 1 && ReferenceEquals(stack[0], root);
            foreach (var tok in tokens)
            {
                switch (tok)
                {
                    case VarTok v:
                        if (v.Value == ".") break; // implicit iterator — always valid
                        if (atRoot) referencedAtRoot.Add(v.Value.Split('.')[0]);
                        if (Resolve(stack, v.Value) is null
                            && !PayloadAccessors.IsBooleanAccessor(stack, v.Value))
                            errors.Add(new VerifyError(ERR_VAR_NOT_ON_PAYLOAD, v.Value));
                        break;

                    case SectionTok s:
                        if (s.Value == ".") { Walk(s.Children, stack, seen); break; }
                        if (atRoot) referencedAtRoot.Add(s.Value.Split('.')[0]);
                        var field = Resolve(stack, s.Value);
                        if (field is null)
                        {
                            // A derived `has<Field>` gate is a BOOLEAN over the current
                            // context: it resolves nothing and pushes nothing, so walk the
                            // body in the SAME scope — what `{{#hasX}}{{#x}}…` depends on.
                            if (PayloadAccessors.IsBooleanAccessor(stack, s.Value))
                            {
                                Walk(s.Children, stack, seen);
                                break;
                            }
                            // Unresolved section head is itself drift; skip the body
                            // (its context is unknowable; walking it cascades false errors).
                            errors.Add(new VerifyError(ERR_VAR_NOT_ON_PAYLOAD, s.Value));
                            break;
                        }
                        // `#` over a container pushes its element fields; `^` (and `#`
                        // over a scalar, used as a conditional) keep the current context.
                        bool push = !s.Inverted && field.Fields is not null;
                        if (push)
                        {
                            var next = new List<IReadOnlyList<PayloadField>>(stack) { field.Fields! };
                            Walk(s.Children, next, seen);
                        }
                        else Walk(s.Children, stack, seen);
                        break;

                    case PartialTok p:
                        if (provider is null) break;
                        if (seen.Contains(p.Value) || seen.Count >= MaxDepth) break;
                        var text = provider.Resolve(p.Value);
                        if (text is null)
                        {
                            errors.Add(new VerifyError(ERR_PARTIAL_UNRESOLVED, p.Value));
                            break;
                        }
                        staticTexts.Add(text);
                        Walk(Tokenize(text), stack, new List<string>(seen) { p.Value });
                        break;
                }
            }
        }

        Walk(Tokenize(templateText), [root], []);

        foreach (var slot in options?.RequiredSlots ?? [])
            if (!referencedAtRoot.Contains(slot))
                errors.Add(new VerifyError(ERR_REQUIRED_SLOT_UNUSED, slot));

        var requiredTags = options?.RequiredTags ?? [];
        if (requiredTags.Count > 0)
        {
            // Scan body + resolved partials as one joined string: the open and close
            // forms are located independently, so a tag may legitimately straddle the
            // boundary. The "\n" separator only blocks a spurious tag spliced together
            // from two fragments (a real tag is always contiguous within one body).
            var haystack = string.Join('\n', staticTexts);
            foreach (var tag in requiredTags)
                if (!HasOpenTag(haystack, tag) || !HasCloseTag(haystack, tag))
                    errors.Add(new VerifyError(ERR_OUTPUT_TAG_MISSING, tag));
        }

        return errors;
    }

    // An opening tag is `<tag` immediately followed by `>` or XML whitespace, so
    // attributes are allowed (`<answer foo="1">`) but a longer name is not over-matched
    // (`<answers>` does not satisfy `answer`).
    private static readonly char[] TagOpenDelims = ['>', ' ', '\t', '\n', '\r'];

    private static bool HasOpenTag(string text, string tag)
    {
        var needle = "<" + tag;
        for (int i = text.IndexOf(needle, StringComparison.Ordinal); i >= 0;
             i = text.IndexOf(needle, i + 1, StringComparison.Ordinal))
        {
            int after = i + needle.Length;
            if (after < text.Length && Array.IndexOf(TagOpenDelims, text[after]) >= 0) return true;
        }
        return false;
    }

    // A closing tag is the exact literal `</tag>`. A self-closing `<tag/>` has no such
    // form, so it never satisfies a required tag — these wrap content a parser reads.
    private static bool HasCloseTag(string text, string tag) =>
        text.Contains("</" + tag + ">", StringComparison.Ordinal);
}
