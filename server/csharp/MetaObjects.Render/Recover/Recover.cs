namespace MetaObjects.Render.Recover;

/// <summary>
/// Public entry point. Runs the 8-stage pipeline; never throws.
/// </summary>
public static class Recover
{
    /// <summary>
    /// Recover structured data from <paramref name="text"/> according to <paramref name="schema"/>.
    /// Never throws. Returns a <see cref="RecoverOutcome"/> whose
    /// <see cref="RecoverOutcome.Data"/> map holds successfully coerced values and whose
    /// <see cref="RecoverOutcome.Report"/> describes the classification of every declared field.
    /// </summary>
    public static RecoverOutcome Run(string? text, RecoverSchema schema, RecoverOptions? opts = null)
    {
        RecoverOptions o = opts ?? RecoverOptions.Defaults();
        RecoveryReport report = new();
        Dictionary<string, object?> data = new(StringComparer.Ordinal);

        string stripped = Strip.Apply(text);
        bool ci = o.Tolerance != Tolerance.Strict;

        string? span = schema.Format == Format.Json
            ? Locate.Json(stripped)
            : Locate.Xml(stripped, schema.RootName, ci);

        Dictionary<string, object?> raw;
        if (span == null)
            raw = new Dictionary<string, object?>();
        else if (schema.Format == Format.Json)
            raw = new JsonForgivingReader().Read(span);
        else
            raw = new XmlForgivingReader().Read(span, ci);

        if (raw.Count == 0 && (stripped.Length == 0 || span == null))
        {
            report.MarkEmpty();
        }

        Extract(schema.Fields, raw, "", data, report, o, ci);
        return new RecoverOutcome(data, report);
    }

    private static void Extract(
        IReadOnlyList<FieldSpec> fields,
        Dictionary<string, object?> raw,
        string prefix,
        Dictionary<string, object?> data,
        RecoveryReport report,
        RecoverOptions o,
        bool ci)
    {
        foreach (FieldSpec f in fields)
        {
            string path = prefix.Length == 0 ? f.Name : prefix + "." + f.Name;
            object? present = Lookup(raw, f.Name, ci);

            if (present == null)
            {
                // FR-011: an absent enum with a declared @default fills the value → DEFAULTED
                // (which satisfies a @required field).
                if (f.Kind == FieldKind.Enum && f.DefaultValue != null)
                {
                    data[f.Name] = f.DefaultValue;
                    report.AddCoercion(new Coercion(path, "", f.DefaultValue, "default"));
                    report.Set(path, FieldRecovery.DEFAULTED);
                    continue;
                }
                report.Set(path, f.Required ? FieldRecovery.LOST_REQUIRED : FieldRecovery.LOST_OPTIONAL);
                continue;
            }

            if (ReferenceEquals(present, JsonForgivingReader.Truncated))
            {
                report.Set(path, FieldRecovery.MALFORMED);
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
                for (int idx = 0; idx < elements.Count; idx++)
                {
                    object? v = ExtractValue(f, elements[idx], path + "[" + idx + "]", report, o, ci);
                    if (ReferenceEquals(v, Coerce.Malformed))
                        anyMalformed = true;
                    else
                        outList.Add(v);
                }
                // NOTE (cross-port contract): a MALFORMED array still places its successfully-coerced
                // elements into data (partial recovery), UNLIKE a MALFORMED scalar which is absent from
                // data. Consumers branching on state must account for partial array data.
                data[f.Name] = outList;
                report.Set(path, anyMalformed ? FieldRecovery.MALFORMED : FieldRecovery.RECOVERED);
                continue;
            }

            if (present is List<object?>)
            {
                // a list where a singular value was expected
                report.Set(path, FieldRecovery.MALFORMED);
                continue;
            }

            object? val = ExtractValue(f, present, path, report, o, ci);
            if (ReferenceEquals(val, Coerce.Malformed))
            {
                report.Set(path, FieldRecovery.MALFORMED);
            }
            else
            {
                data[f.Name] = val;
                // FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED, not RECOVERED.
                report.Set(path, ClassifyCoerced(path, report));
            }
        }
    }

    /// <summary>
    /// FR-011: classify a successfully-coerced field. DEFAULTED when its terminal (last-logged)
    /// coercion for this path is a default-class fallback; RECOVERED otherwise. Nested objects
    /// (which log no coercion of their own) classify as RECOVERED. Mirrors the TS classifyCoerced.
    /// </summary>
    private static FieldRecovery ClassifyCoerced(string path, RecoveryReport report)
    {
        string? terminalKind = null;
        foreach (Coercion c in report.Coercions())
            if (c.FieldPath == path) terminalKind = c.Kind;
        return terminalKind is "coerceDefault" or "default"
            ? FieldRecovery.DEFAULTED
            : FieldRecovery.RECOVERED;
    }

    /// <summary>
    /// Coerce one (non-array) element: nested-object recursion or scalar coercion.
    /// Returns <see cref="Coerce.Malformed"/> on failure.
    /// </summary>
    private static object? ExtractValue(
        FieldSpec f,
        object? present,
        string path,
        RecoveryReport report,
        RecoverOptions o,
        bool ci)
    {
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
