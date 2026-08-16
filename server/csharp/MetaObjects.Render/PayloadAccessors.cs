namespace MetaObjects.Render;

/// <summary>
/// Derived boolean accessors — <c>{{#hasFoo}}</c> over a payload field <c>foo</c>.
/// </summary>
/// <remarks>
/// <para>
/// A prompt needs conditional sections ("include the abilities block only when there ARE
/// abilities"), and the payload contract answers that with a DERIVED accessor rather than
/// an authored boolean field: the author declares <c>abilities</c> and <c>hasAbilities</c>
/// follows from it. Declaring both would let them disagree.
/// </para>
/// <para>
/// THE RULE IS SHARED ACROSS PORTS ON PURPOSE. The JVM has carried it since 7.7.7
/// (<c>com.metaobjects.render.PayloadAccessors</c>, emitted onto every generated payload
/// record and accepted by its <c>Verify</c>), and its comment says emitter and verifier
/// share one rule so they "can never drift apart". C# had neither half, so the same
/// template verified clean on the JVM and reported drift here — and rendered WRONG rather
/// than failing, silently dropping the section. Gated cross-port by the
/// <c>render-derived-has-accessor</c> conformance case.
/// </para>
/// </remarks>
public static class PayloadAccessors
{
    /// <summary>The <c>has</c> prefix every derived boolean accessor carries.</summary>
    public const string HasPrefix = "has";

    /// <summary>
    /// The boolean-accessor section name for a payload field: <c>"has" + Capitalize(name)</c>
    /// (<c>abilities</c> → <c>hasAbilities</c>). Byte-identical to the JVM's
    /// <c>PayloadAccessors.hasAccessorName</c>, including its capitalize, which leaves an
    /// already-uppercase first character untouched.
    /// </summary>
    public static string HasAccessorName(string fieldName) => HasPrefix + Capitalize(fieldName);

    /// <summary>Capitalize the first character, leaving an already-uppercase one untouched.</summary>
    public static string Capitalize(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        char c0 = s[0];
        if (char.IsUpper(c0)) return s;
        return char.ToUpperInvariant(c0) + s.Substring(1);
    }

    /// <summary>
    /// True when <paramref name="name"/> is a derived boolean accessor over a field reachable
    /// on the current context stack. Mirrors the JVM's <c>Verify.isBooleanAccessor</c>,
    /// including its deliberate permissiveness: acceptance keys off the FIELD EXISTING, not
    /// off its type. Accessors are simple (undotted) names.
    /// </summary>
    public static bool IsBooleanAccessor(List<IReadOnlyList<PayloadField>> stack, string name)
    {
        if (name.Contains('.')) return false;
        if (!name.StartsWith(HasPrefix, StringComparison.Ordinal)) return false;
        // Mustache outward walk (innermost → outermost) — the accessor is reachable
        // exactly where its underlying field is.
        for (int i = stack.Count - 1; i >= 0; i--)
            foreach (var f in stack[i])
                if (name == HasAccessorName(f.Name)) return true;
        return false;
    }

    /// <summary>
    /// Is <paramref name="value"/> "present" for the purposes of <c>has&lt;Field&gt;</c>?
    /// Mirrors the JVM emitter's per-type bodies exactly: string → non-null and non-blank;
    /// collection → non-null and non-empty; reference → non-null. Returns <c>null</c> for
    /// numbers and booleans, which the JVM deliberately emits NO accessor for — nothing is
    /// injected, so the name stays unresolved exactly as on a record with no such method.
    /// </summary>
    public static bool? AccessorValue(object? value)
    {
        switch (value)
        {
            case null: return false;
            case string str: return !string.IsNullOrWhiteSpace(str);
            case bool: return null;
            case sbyte or byte or short or ushort or int or uint or long or ulong
                or float or double or decimal: return null;
            case System.Collections.IEnumerable seq:
            {
                foreach (var _ in seq) return true;
                return false;
            }
            default: return true;
        }
    }

    /// <summary>
    /// A view over <paramref name="payload"/> carrying its derived <c>has&lt;Field&gt;</c>
    /// accessors, recursively. NON-MUTATING — a render must not change the object it was
    /// handed. An AUTHORED key always wins. Recursion follows Mustache's own scoping, so
    /// every nested object and every collection ELEMENT becomes a context in its own right.
    /// </summary>
    public static object? WithDerivedAccessors(object? payload, int depth = 0)
    {
        if (depth > 32 || payload is null) return payload; // pathological graph
        if (payload is string) return payload;

        if (payload is System.Collections.IDictionary dict)
        {
            var outMap = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (System.Collections.DictionaryEntry e in dict)
            {
                if (e.Key is not string k) continue;
                outMap[k] = WithDerivedAccessors(e.Value, depth + 1);
            }
            foreach (System.Collections.DictionaryEntry e in dict)
            {
                if (e.Key is not string k) continue;
                string name = HasAccessorName(k);
                if (outMap.ContainsKey(name)) continue; // authored wins
                bool? derived = AccessorValue(e.Value);
                if (derived is not null) outMap[name] = derived;
            }
            return outMap;
        }

        if (payload is System.Collections.IEnumerable seq)
        {
            var outList = new List<object?>();
            foreach (var item in seq) outList.Add(WithDerivedAccessors(item, depth + 1));
            return outList;
        }

        return payload;
    }
}
