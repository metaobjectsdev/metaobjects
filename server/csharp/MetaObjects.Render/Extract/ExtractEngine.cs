namespace MetaObjects.Render.Extract;

/// <summary>
/// Public entry point. Runs the 8-stage pipeline; never throws.
/// </summary>
public static class ExtractEngine
{
    /// <summary>
    /// Extract structured data from <paramref name="text"/> according to <paramref name="schema"/>.
    /// Never throws. Returns a <see cref="ExtractionOutcome"/> whose
    /// <see cref="ExtractionOutcome.Data"/> map holds successfully coerced values and whose
    /// <see cref="ExtractionOutcome.Report"/> describes the classification of every declared field.
    /// </summary>
    public static ExtractionOutcome Run(string? text, ExtractSchema schema, ExtractOptions? opts = null)
    {
        ExtractOptions o = opts ?? ExtractOptions.Defaults();
        ExtractionReport report = new();
        Dictionary<string, object?> data = new(StringComparer.Ordinal);

        string stripped = Strip.Apply(text);
        bool ci = o.Tolerance != Tolerance.Strict;

        // XML rootless (opts.Rootless): the payload's fields ARE the top-level elements — there is
        // no enclosing root to locate — so parse the whole stripped text's top-level elements
        // directly. Otherwise locate the <rootName> span as before. JSON is unaffected.
        // Mirrors Java Extract.extract.
        string? span;
        Dictionary<string, object?> raw;
        if (schema.Format == Format.Json)
        {
            span = Locate.Json(stripped);
            raw = span == null ? new Dictionary<string, object?>() : new JsonForgivingReader().Read(span);
        }
        else if (o.Rootless)
        {
            span = stripped.Length == 0 ? null : stripped;
            raw = span == null ? new Dictionary<string, object?>() : new XmlForgivingReader().ReadRootless(stripped, ci);
        }
        else
        {
            span = Locate.Xml(stripped, schema.RootName, ci);
            raw = span == null ? new Dictionary<string, object?>() : new XmlForgivingReader().Read(span, ci);
        }

        if (raw.Count == 0 && (stripped.Length == 0 || span == null))
        {
            report.MarkEmpty();
        }

        Extract(schema.Fields, raw, "", data, report, o, ci);
        return new ExtractionOutcome(data, report);
    }

    private static void Extract(
        IReadOnlyList<FieldSpec> fields,
        Dictionary<string, object?> raw,
        string prefix,
        Dictionary<string, object?> data,
        ExtractionReport report,
        ExtractOptions o,
        bool ci)
    {
        foreach (FieldSpec f in fields)
        {
            string path = prefix.Length == 0 ? f.Name : prefix + "." + f.Name;
            // A @xmlText field reads the element's text body (carried under the #text sentinel when
            // the element also has attributes), not a same-named child element.
            object? present = f.TextContent
                ? (raw.TryGetValue(XmlForgivingReader.TextKey, out object? txt) ? txt : null)
                : Lookup(raw, f.Name, ci);

            if (present == null)
            {
                // FR-011 / Phase B: an absent field with a declared @default fills the value
                // → DEFAULTED (which satisfies a @required field). Generalized to all field
                // kinds: an enum default is its member string as-is; a non-enum default is
                // coerced to the field's kind via Coerce.Scalar (so @default "0" on field.int
                // yields integer 0). A non-coercible non-enum default is treated as no default.
                if (f.DefaultValue != null)
                {
                    object? coerced = f.Kind == FieldKind.Enum
                        ? f.DefaultValue
                        : Coerce.Scalar(f.DefaultValue, f);
                    if (!ReferenceEquals(coerced, Coerce.Malformed))
                    {
                        data[f.Name] = coerced;
                        report.AddCoercion(new Coercion(path, "", f.DefaultValue, "default"));
                        report.Set(path, FieldExtraction.DEFAULTED);
                        // A default SATISFIES @required, so this field never appears in
                        // LostRequired() — which is what the generated guards key on. Record it
                        // separately so "the document did not answer a required field" stays askable.
                        if (f.Required) report.MarkDefaultedRequired(path);
                        continue;
                    }
                }
                report.Set(path, f.Required ? FieldExtraction.LOST_REQUIRED : FieldExtraction.LOST_OPTIONAL);
                continue;
            }

            if (ReferenceEquals(present, JsonForgivingReader.Truncated))
            {
                report.Set(path, FieldExtraction.MALFORMED);
                continue;
            }

            if (ReferenceEquals(present, JsonForgivingReader.NullLiteral))
            {
                // The JSON null literal is the caller's explicit "no value": leave the field null
                // (do NOT apply @default — an explicit null is a value, not an omission), matching
                // a standard JSON bind. Without this the bare `null` token leaks as the string "null".
                report.Set(path, f.Required ? FieldExtraction.LOST_REQUIRED : FieldExtraction.LOST_OPTIONAL);
                continue;
            }

            if (f.Array)
            {
                // An array field: a single non-list value is treated as a one-element array
                // (e.g. a single repeated-XML tag). Each element is coerced/recursed independently.
                IReadOnlyList<object?> elements = present is List<object?> l
                    ? l
                    : new List<object?> { present };

                var outList = new List<object?>();
                bool anyMalformed = false;
                // Phase B (array-of-enum): an enum element flows through the SAME enum coercion
                // pipeline a scalar enum uses, and is CLASSIFIED per element by indexed path
                // (tags[0], tags[1], …) exactly as a scalar enum: EXTRACTED / DEFAULTED (via
                // @coerceDefault) / MALFORMED. Non-enum scalar arrays keep their existing
                // behavior (raw element list, no per-element states).
                bool enumElements = f.Kind == FieldKind.Enum;
                for (int idx = 0; idx < elements.Count; idx++)
                {
                    string elemPath = path + "[" + idx + "]";
                    object? v = ExtractValue(f, elements[idx], elemPath, report, o, ci);
                    if (ReferenceEquals(v, Coerce.Malformed))
                    {
                        anyMalformed = true;
                        if (enumElements) report.Set(elemPath, FieldExtraction.MALFORMED);
                    }
                    else
                    {
                        outList.Add(v);
                        if (enumElements) report.Set(elemPath, ClassifyCoerced(elemPath, report));
                    }
                }
                // NOTE (cross-port contract): a MALFORMED array still places its successfully-coerced
                // elements into data (partial extraction), UNLIKE a MALFORMED scalar which is absent from
                // data. Consumers branching on state must account for partial array data.
                data[f.Name] = outList;
                report.Set(path, anyMalformed ? FieldExtraction.MALFORMED : FieldExtraction.EXTRACTED);
                continue;
            }

            if (present is List<object?>)
            {
                // a list where a singular value was expected
                report.Set(path, FieldExtraction.MALFORMED);
                continue;
            }

            object? val = ExtractValue(f, present, path, report, o, ci);
            if (ReferenceEquals(val, Coerce.Malformed))
            {
                report.Set(path, FieldExtraction.MALFORMED);
            }
            else
            {
                data[f.Name] = val;
                // FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED, not EXTRACTED.
                report.Set(path, ClassifyCoerced(path, report));
            }
        }
    }

    /// <summary>
    /// FR-011: classify a successfully-coerced field. DEFAULTED when its terminal (last-logged)
    /// coercion for this path is a default-class fallback; EXTRACTED otherwise. Nested objects
    /// (which log no coercion of their own) classify as EXTRACTED. Mirrors the TS classifyCoerced.
    /// </summary>
    private static FieldExtraction ClassifyCoerced(string path, ExtractionReport report)
    {
        string? terminalKind = null;
        foreach (Coercion c in report.Coercions())
            if (c.FieldPath == path) terminalKind = c.Kind;
        return terminalKind is "coerceDefault" or "default"
            ? FieldExtraction.DEFAULTED
            : FieldExtraction.EXTRACTED;
    }

    /// <summary>
    /// Coerce one (non-array) element: nested-object recursion or scalar coercion.
    /// Returns <see cref="Coerce.Malformed"/> on failure.
    /// </summary>
    private static object? ExtractValue(
        FieldSpec f,
        object? present,
        string path,
        ExtractionReport report,
        ExtractOptions o,
        bool ci)
    {
        if (ReferenceEquals(present, JsonForgivingReader.NullLiteral))
        {
            // A JSON null array element (e.g. [1, null, 3]) carries no value → drop it as malformed
            // rather than letting the sentinel stringify.
            return Coerce.Malformed;
        }
        if (f.Kind == FieldKind.Object)
        {
            if (f.Nested != null && present is Dictionary<string, object?> m)
            {
                var nestedData = new Dictionary<string, object?>(StringComparer.Ordinal);
                Extract(f.Nested.Fields, m, path, nestedData, report, o, ci);
                return nestedData;
            }
            // object expected but scalar/non-map present
            return Coerce.Malformed;
        }

        // A text element that also carried XML attributes is represented by XmlForgivingReader
        // as a dictionary with the body under TextKey. A scalar field reads that text (attributes
        // ignored for scalars — preserving pre-attribute-support behaviour).
        if (present is Dictionary<string, object?> mp && mp.ContainsKey(XmlForgivingReader.TextKey))
        {
            present = mp[XmlForgivingReader.TextKey];
        }

        string rawStr = present is string s ? s : Convert.ToString(present) ?? "";
        return Coerce.Value(rawStr, f, o, path, report);
    }

    /// <summary>Case-folding lookup honoring tolerance.</summary>
    private static object? Lookup(Dictionary<string, object?> raw, string name, bool ci)
    {
        if (raw.TryGetValue(name, out object? found)) return found;
        if (ci)
        {
            foreach (var kv in raw)
            {
                if (string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase))
                    return kv.Value;
            }
        }
        return null;
    }
}
