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

    /// <summary>
    /// The positional accessor injected into every map-shaped ELEMENT of a collection, so a
    /// list separator needs no hand-computed <c>last</c> flag:
    /// <c>{{#items}}{{name}}{{^-last}}, {{/-last}}{{/items}}</c>. The leading <c>-</c> cannot
    /// collide with a field name and is still an ordinary Mustache tag name, so the template
    /// stays valid Mustache. A scalar element has nowhere to hold a key and carries none; an
    /// authored key of the same name wins, as for <c>has&lt;Field&gt;</c>.
    /// </summary>
    public const string LastAccessor = "-last";

    /// <summary>True when <paramref name="name"/> is <c>-last</c> and the scope is a collection element.</summary>
    public static bool IsPositionalAccessor(bool inElement, string name) =>
        inElement && name == LastAccessor;

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
            // A dictionary IS IEnumerable, so it must be matched FIRST — otherwise an
            // empty nested object reports absent here and present in every other port.
            case System.Collections.IDictionary: return true;
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
            for (int i = 0; i < outList.Count; i++)
            {
                if (outList[i] is not Dictionary<string, object?> el) continue;
                el.TryAdd(LastAccessor, i == outList.Count - 1);
            }
            return outList;
        }

        // ADR-0056 — a typed payload (a generated value-object POCO, a record, an anonymous
        // object). A template names the FIELD (`{{bio}}`), and a generated POCO carries that
        // name in [JsonPropertyName] on a PascalCase member, so a typed object is viewed as the
        // map of its readable public members keyed by wire name (or the member's own name when
        // it declares none — exactly the name reflection lookup resolved before). The view is
        // what carries the derived has<Field> and -last accessors, so a typed payload renders
        // byte-identically to the equal map payload. A scalar-like value (number, enum, date,
        // Guid, JsonElement, ...) is never viewed: its string form is its own.
        if (IsScalarLike(payload.GetType())) return payload;
        {
            var asMap = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (name, read) in MemberReaders(payload.GetType())) asMap.TryAdd(name, read(payload));
            return WithDerivedAccessors(asMap, depth);
        }
    }

    private static bool IsScalarLike(Type t) =>
        t.IsPrimitive || t.IsEnum || t.Namespace is "System" || t.Namespace?.StartsWith("System.", StringComparison.Ordinal) == true;

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<Type, (string, Func<object, object?>)[]>
        MemberCache = new();

    /// <summary>
    /// The readable public instance members of <paramref name="type"/>, each keyed by its
    /// <c>[JsonPropertyName]</c> (or its own name when it has none). Cached per type.
    /// </summary>
    private static (string, Func<object, object?>)[] MemberReaders(Type type) =>
        MemberCache.GetOrAdd(type, static t =>
        {
            const System.Reflection.BindingFlags Flags =
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance;
            string WireName(System.Reflection.MemberInfo m) =>
                (m.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonPropertyNameAttribute), inherit: true)
                    .FirstOrDefault() as System.Text.Json.Serialization.JsonPropertyNameAttribute)?.Name ?? m.Name;
            var readers = new List<(string, Func<object, object?>)>();
            foreach (var p in t.GetProperties(Flags).Where(p => p.CanRead && p.GetIndexParameters().Length == 0))
                readers.Add((WireName(p), o => p.GetValue(o)));
            foreach (var f in t.GetFields(Flags))
                readers.Add((WireName(f), o => f.GetValue(o)));
            return readers.ToArray();
        });
}
