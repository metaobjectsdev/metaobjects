// WriteCoercion — the shared YAML→CLR coercion for the runtime WRITE path.
//
// Every persistence WRITE verb (op: roundtrip / create / update) maps a field's
// YAML authoring value onto the generated EF entity property, coercing the
// authoring form to the property's CLR type:
//
//   * a quoted scalar keeps its STRING style, so a full int64 (> 2^53) authored as
//     "9223372036854775807" round-trips through long.Parse with NO precision loss
//     (a port routing it through a double / JS number / 32-bit int would corrupt
//     the low bits); a quoted decimal / uuid likewise stays a string until parsed.
//   * a temporal string parses to DateOnly / TimeOnly / DateTime with the right
//     DateTimeKind (trailing "Z" → Utc → timestamptz; no "Z" → Unspecified →
//     plain timestamp), the write-side mirror of Normalization.FormatDateTime.
//   * an enum symbol → the nested enum; a uuid string → Guid.
//   * a nested mapping → an owned value-object POCO (EF serializes it to jsonb).
//
// Routing UPDATE through this SAME coercion (not a separate PATCH path) is the
// point of update-delete-all-types.yaml: a port whose UPDATE codec diverges from
// its INSERT codec (PATCH paths frequently skip the INSERT type coercion) is
// caught by that scenario's per-subtype re-encode assertions.

using System.Globalization;
using System.Net;
using System.Reflection;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace MetaObjects.IntegrationTests.Runner;

public static class WriteCoercion
{
    /// <summary>The Pascal-cased CLR property for a lowerCamel metadata field name.</summary>
    public static PropertyInfo Property(Type entity, string fieldName) =>
        entity.GetProperty(char.ToUpperInvariant(fieldName[0]) + fieldName[1..])
        ?? throw new InvalidOperationException(
            $"Entity '{entity.Name}' has no property for metadata field '{fieldName}'");

    /// <summary>
    /// Coerce a YAML authoring value to the target property's CLR type. Handles the
    /// scalar subtypes (string/int/long/double/float/decimal/bool/currency),
    /// temporal (DateOnly/TimeOnly/DateTime with the right Kind), uuid (Guid), enum
    /// (by symbol), and a nested mapping → an owned value-object POCO.
    /// </summary>
    public static object? CoerceToProperty(YamlNode node, Type targetType, PropertyInfo prop)
    {
        // A nested object authoring form (the @objectRef jsonb value-object).
        if (node is YamlMappingNode map)
            return BuildPoco(map, Nullable.GetUnderlyingType(targetType) ?? targetType);

        // An @isArray object/scalar field authoring form: a YAML sequence → a List<TElement>.
        // The generated property is ICollection<TElement> (EF maps a VO collection via
        // .OwnsMany(...).ToJson(...)). Each element is coerced to the collection's element type
        // (a mapping → an owned POCO; a scalar → its CLR value). An empty sequence yields an
        // empty (non-null) list — distinct from a null/absent value.
        if (node is YamlSequenceNode seq)
        {
            var elementType = CollectionElementType(targetType)
                ?? throw new InvalidOperationException(
                    $"'{prop.Name}' received a YAML sequence but its CLR type {targetType.Name} is not a supported collection");
            var list = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(elementType))!;
            foreach (var item in seq.Children)
                list.Add(CoerceToProperty(item, elementType, prop));
            return list;
        }

        if (node is not YamlScalarNode scalar)
            throw new InvalidOperationException(
                $"unsupported write value for '{prop.Name}' (kind {node.GetType().Name})");

        var raw = scalar.Value;
        if (raw is null || (scalar.Style is ScalarStyle.Plain && raw is "" or "~" or "null" or "Null" or "NULL"))
            return null;

        var underlying = Nullable.GetUnderlyingType(targetType) ?? targetType;

        if (underlying.IsEnum)   return Enum.Parse(underlying, raw, ignoreCase: false);
        if (underlying == typeof(Guid))    return Guid.Parse(raw);
        // ADR-0036 Wave 3 — field.uri → System.Uri (EF's HasConversion stores v.ToString()
        // to the text column); field.inet → System.Net.IPAddress (Npgsql binds IPAddress↔inet
        // natively, no CIDR mask on a HOST address).
        if (underlying == typeof(Uri))       return new Uri(raw);
        if (underlying == typeof(IPAddress)) return IPAddress.Parse(raw);
        if (underlying == typeof(bool))    return ParseBool(raw);
        if (underlying == typeof(string))  return raw;
        if (underlying == typeof(int))     return int.Parse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture);
        if (underlying == typeof(long))    return long.Parse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture);
        if (underlying == typeof(double))  return double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (underlying == typeof(float))   return float.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (underlying == typeof(decimal)) return decimal.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (underlying == typeof(DateOnly)) return DateOnly.ParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (underlying == typeof(TimeOnly)) return ParseTime(raw);
        if (underlying == typeof(DateTime)) return ParseDateTime(raw);
        // ADR-0036 Wave 2 — a default field.timestamp binds to DateTimeOffset (an absolute
        // instant over timestamptz). Parse the authoring instant to an offset-aware value;
        // a trailing "Z" yields a UTC (+00:00) DateTimeOffset, the timestamptz write form.
        if (underlying == typeof(DateTimeOffset)) return ParseDateTimeOffset(raw);

        throw new InvalidOperationException(
            $"no write coercion for '{prop.Name}' of CLR type {underlying.Name}");
    }

    // The element type of a generic collection property (ICollection<T>/IList<T>/List<T>/
    // IEnumerable<T>), or null if targetType is not such a collection. `string` is excluded
    // (it is IEnumerable<char> but a scalar here). The generated array property is exactly
    // ICollection<T>, so the direct generic-definition check covers it.
    private static Type? CollectionElementType(Type targetType)
    {
        if (targetType == typeof(string)) return null;
        if (targetType.IsGenericType)
        {
            var def = targetType.GetGenericTypeDefinition();
            if (def == typeof(ICollection<>) || def == typeof(IList<>) || def == typeof(List<>) ||
                def == typeof(IEnumerable<>) || def == typeof(IReadOnlyList<>) || def == typeof(IReadOnlyCollection<>))
                return targetType.GetGenericArguments()[0];
        }
        return targetType.GetInterfaces()
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(ICollection<>))
            ?.GetGenericArguments()[0];
    }

    private static bool ParseBool(string raw) => raw switch
    {
        "true" or "True" or "TRUE" => true,
        "false" or "False" or "FALSE" => false,
        _ => bool.Parse(raw),
    };

    // TIME authoring form: "HH:mm:ss" or "HH:mm:ss.fff".
    private static TimeOnly ParseTime(string raw) =>
        TimeOnly.ParseExact(raw,
            raw.Contains('.') ? "HH:mm:ss.FFFFFFF" : "HH:mm:ss", CultureInfo.InvariantCulture);

    // Temporal authoring forms:
    //   * trailing "Z"  → a TIMESTAMPTZ instant; parse as UTC and tag Kind=Utc.
    //   * no "Z"        → a wall-clock TIMESTAMP; tag Kind=Unspecified.
    private static DateTime ParseDateTime(string raw)
    {
        if (raw.EndsWith('Z'))
        {
            var dt = DateTime.Parse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
            return DateTime.SpecifyKind(dt, DateTimeKind.Utc);
        }
        var local = DateTime.Parse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None);
        return DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
    }

    // ADR-0036 Wave 2 — a default field.timestamp instant → DateTimeOffset (timestamptz).
    // A trailing "Z" (or any explicit offset) parses to the matching offset; convert to
    // UTC so the write is offset-canonical (Npgsql maps a UTC DateTimeOffset to timestamptz).
    private static DateTimeOffset ParseDateTimeOffset(string raw)
    {
        var dto = DateTimeOffset.Parse(raw, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        return dto.ToUniversalTime();
    }

    // Build an owned value-object POCO from a nested mapping, coercing each member to
    // its property type (recursively). EF serializes this to the jsonb column.
    private static object BuildPoco(YamlMappingNode map, Type pocoType)
    {
        var instance = Activator.CreateInstance(pocoType)
            ?? throw new InvalidOperationException($"could not instantiate value object '{pocoType.Name}'");
        foreach (var (keyNode, valueNode) in map.Children)
        {
            var fieldName = ((YamlScalarNode)keyNode).Value!;
            var prop = Property(pocoType, fieldName);
            prop.SetValue(instance, CoerceToProperty(valueNode, prop.PropertyType, prop));
        }
        return instance;
    }
}
