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
    /// A view over <paramref name="payload"/> carrying its derived accessors, recursively:
    /// <c>has&lt;Field&gt;</c> on every object, and <c>-last</c> on every object that is an
    /// element of a collection. NON-MUTATING — a render must not change the object it was
    /// handed. An AUTHORED member always wins. Recursion follows Mustache's own scoping, so
    /// every nested object and every collection ELEMENT becomes a context in its own right.
    /// A typed object with no wire names comes back as an overlay only
    /// <see cref="Renderer"/>'s engine resolves (<see cref="ViewType"/> / <see cref="ViewLookup"/>).
    /// </summary>
    public static object? WithDerivedAccessors(object? payload, int depth = 0) => Derive(payload, depth, null);

    /// <summary><paramref name="last"/> is set only for an element of a collection: its position.</summary>
    private static object? Derive(object? payload, int depth, bool? last)
    {
        if (depth > 32 || payload is null) return payload; // pathological graph
        if (payload is string) return payload;

        if (payload is System.Collections.IDictionary dict)
        {
            var outMap = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (System.Collections.DictionaryEntry e in dict)
            {
                if (e.Key is not string k) continue;
                outMap[k] = Derive(e.Value, depth + 1, null);
            }
            foreach (System.Collections.DictionaryEntry e in dict)
            {
                if (e.Key is not string k) continue;
                string name = HasAccessorName(k);
                if (outMap.ContainsKey(name)) continue; // authored wins
                bool? derived = AccessorValue(e.Value);
                if (derived is not null) outMap[name] = derived;
            }
            if (last is bool position) outMap.TryAdd(LastAccessor, position);
            return outMap;
        }

        if (payload is System.Collections.IEnumerable seq)
        {
            var items = seq.Cast<object?>().ToList();
            var outList = new List<object?>(items.Count);
            for (int i = 0; i < items.Count; i++) outList.Add(Derive(items[i], depth + 1, i == items.Count - 1));
            return outList;
        }

        // ADR-0056 — a generated value-object POCO. Its members are PascalCase C# properties
        // that carry the metadata field name in [JsonPropertyName], while a template names the
        // FIELD (`{{bio}}`). So the POCO is viewed as the map of its wire names, which also gives
        // it the derived accessors a map payload gets.
        if (WireNamedProperties(payload.GetType()) is { } props)
        {
            var asMap = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (name, prop) in props) asMap[name] = prop.GetValue(payload);
            return Derive(asMap, depth, last);
        }

        // A value the engine treats specially by its TYPE — a scalar, a formattable value, a
        // lambda, a dynamic object — is handed over untouched. Any other object is overlaid.
        if (payload is IConvertible or IFormattable or Delegate or System.Dynamic.IDynamicMetaObjectProvider)
            return payload;
        return new TypedView(payload, depth, last);
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<Type, (string, System.Reflection.PropertyInfo)[]?>
        WireNameCache = new();

    /// <summary>
    /// The readable public properties of <paramref name="type"/>, each keyed by its
    /// <c>[JsonPropertyName]</c> (or its own name when it has none) — or null when no property
    /// declares a wire name, which leaves the type to the overlay.
    /// </summary>
    private static (string, System.Reflection.PropertyInfo)[]? WireNamedProperties(Type type) =>
        WireNameCache.GetOrAdd(type, static t =>
        {
            var props = t.GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
                .Where(p => p.CanRead && p.GetIndexParameters().Length == 0)
                .ToArray();
            string? WireName(System.Reflection.PropertyInfo p) =>
                (p.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonPropertyNameAttribute), inherit: true)
                    .FirstOrDefault() as System.Text.Json.Serialization.JsonPropertyNameAttribute)?.Name;
            if (!props.Any(p => WireName(p) is not null)) return null;
            return props.Select(p => (WireName(p) ?? p.Name, p)).ToArray();
        });

    /// <summary>
    /// The derived-accessor overlay of a typed object. The object stays the thing members are
    /// resolved on, and only when the template asks for one; the overlay adds the derived names
    /// on top, and its string form is the object's own.
    /// </summary>
    private sealed class TypedView(object target, int depth, bool? last)
    {
        internal readonly object Target = target;
        internal readonly int Depth = depth;
        internal readonly bool? Last = last;

        public override string? ToString() => Target.ToString();
    }

    /// <summary>The overlay type <see cref="ViewLookup"/> is registered for.</summary>
    internal static Type ViewType => typeof(TypedView);

    // The engine's own reflective member lookup, so a typed object resolves exactly the
    // members it always did: properties, fields and parameterless methods.
    private static readonly Stubble.Core.Settings.RendererSettingsDefaults.ValueGetterDelegate OwnMember =
        Stubble.Core.Settings.RendererSettingsDefaults.DefaultValueGetters()[typeof(object)];

    private const System.Reflection.BindingFlags PublicInstance =
        System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance;

    /// <summary>
    /// The engine's value getter for an overlay: the object's own member when it has one of that
    /// name, else the derived <c>-last</c> / <c>has&lt;Field&gt;</c>.
    /// </summary>
    internal static object? ViewLookup(object value, string key, bool ignoreCase)
    {
        var view = (TypedView)value;
        if (OwnMember(view.Target, key, ignoreCase) is { } own) return Derive(own, view.Depth + 1, null);
        var flags = ignoreCase ? PublicInstance | System.Reflection.BindingFlags.IgnoreCase : PublicInstance;
        Type type = view.Target.GetType();
        if (type.GetMember(key, flags).Length > 0) return null; // authored wins, even when null
        if (key == LastAccessor) return view.Last;
        if (!key.StartsWith(HasPrefix, StringComparison.Ordinal) || key.Length == HasPrefix.Length) return null;
        string rest = key.Substring(HasPrefix.Length);
        foreach (string field in new[] { char.ToLowerInvariant(rest[0]) + rest.Substring(1), rest })
        {
            if (HasAccessorName(field) != key) continue;
            object? read;
            if (type.GetProperty(field, PublicInstance) is { CanRead: true } prop && prop.GetIndexParameters().Length == 0)
                read = prop.GetValue(view.Target);
            else if (type.GetField(field, PublicInstance) is { } fld)
                read = fld.GetValue(view.Target);
            else continue;
            if (AccessorValue(read) is { } derived) return derived;
        }
        return null;
    }
}
