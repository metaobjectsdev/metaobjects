// ValidationIssues — the 400 validation envelope a generated route answers with.
//
//   { "error": "validation", "issues": [ { "code": "too_big", "path": ["name"], "message": "..." } ] }
//
// The shape the TypeScript routes already use. Every issue is listed, not just the first.
//   code    Zod's names: invalid_type (missing or null required key, wrong JSON type, an unparseable
//           value), too_small, too_big (over a max length/value, a decimal over its precision/scale),
//           invalid_format (a regex or format, a malformed date or guid), invalid_value (an enum value
//           that is not a member), custom (anything else).
//   path    the field's WIRE name (not the C# property name), nested value-object members and array
//           indexes as further elements; [] when the body as a whole cannot be read.
//   message the port's own wording, never asserted across ports.
//
// DataAnnotations' ValidationResult does not say WHICH attribute failed, so each property's attributes
// are evaluated one by one here and the attribute type (and, for a length or range, which bound the
// value crossed) decides the code.

using System.Collections;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;

namespace MetaObjects.Codegen.Runtime;

/// <summary>An ordered, de-duplicated list of validation issues, and the 400 response that carries it.</summary>
public sealed class ValidationIssues
{
    private readonly List<Dictionary<string, object?>> _issues = [];
    private readonly HashSet<string> _seen = [];

    /// <summary>How many distinct issues have been recorded.</summary>
    public int Count => _issues.Count;

    /// <summary>True once any issue has been recorded.</summary>
    public bool Any => _issues.Count > 0;

    /// <summary>The recorded issues, as the wire objects.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Issues => _issues;

    /// <summary>The 400 response listing every recorded issue.</summary>
    public IResult ToResult() => Results.BadRequest(new { error = "validation", issues = _issues });

    /// <summary>The 400 for a body that cannot be read as a whole (not JSON, or not an object): one issue, empty path.</summary>
    public static IResult Unreadable(string message = "the request body is not a JSON object")
    {
        var issues = new ValidationIssues();
        issues.Add("invalid_type", message, []);
        return issues.ToResult();
    }

    /// <summary>Record an issue; the same code at the same path is recorded once.</summary>
    public void Add(string code, string message, params object[] path)
    {
        if (!_seen.Add(code + "|" + JsonSerializer.Serialize(path))) return;
        _issues.Add(new Dictionary<string, object?> { ["code"] = code, ["path"] = path.ToList(), ["message"] = message });
    }

    /// <summary>A @required key that is absent or null.</summary>
    public void AddRequired(string wireName) => Add("invalid_type", $"{wireName} is required", wireName);

    /// <summary>
    /// Record a failure to read a value. The exception's own path locates it below <paramref name="prefix"/>;
    /// <paramref name="type"/> (the CLR type at the prefix) lets an enum member that does not exist read as
    /// invalid_value and a value that cannot be read as the target type as invalid_type.
    /// </summary>
    public void AddJson(JsonException error, Type? type, params object[] prefix)
    {
        var path = prefix.ToList();
        path.AddRange(ParseJsonPath(error.Path));
        var message = error.Message;
        var cut = message.IndexOf(" Path: ", StringComparison.Ordinal);
        if (cut > 0) message = message[..cut];
        Add(CodeFor(error, ResolveType(type, path.Skip(prefix.Length))), message, [.. path]);
    }

    /// <summary>
    /// Record a failure to read a value from the body: a JsonException is listed at its path, and so is any other
    /// reader failure (a host converter that cannot take a null or a wrongly typed token may throw anything, such
    /// as an ArgumentNullException or FormatException) unless a more specific issue is already recorded.
    /// </summary>
    public void AddReadFailure(Exception error, Type? type, params object[] prefix)
    {
        if (error is JsonException json) AddJson(json, type, prefix);
        else if (!Any) Add("invalid_type", error.Message, prefix);
    }

    private static string CodeFor(JsonException error, Type? target)
    {
        // A decimal the declared precision and scale cannot hold, or that no decimal can hold.
        if (error.Message.Contains("exceeds the declared precision", StringComparison.Ordinal)
            || error.Message.Contains("out of range", StringComparison.Ordinal)) return "too_big";
        var underlying = target is null ? null : Nullable.GetUnderlyingType(target) ?? target;
        if (underlying is not null && underlying.IsEnum) return "invalid_value";
        // A number or boolean given as the wrong JSON type is a type error, not a format error.
        if (underlying is not null && (underlying.IsPrimitive || underlying == typeof(decimal))) return "invalid_type";
        // A string that is not a date, a guid, a time of day...: System.Text.Json reports the parse failure
        // as the inner FormatException.
        for (Exception? e = error; e is not null; e = e.InnerException)
            if (e is FormatException) return "invalid_format";
        return "invalid_type";
    }

    // "$.items[2].name" -> items, 2, name ; "$" -> nothing.
    private static List<object> ParseJsonPath(string? path)
    {
        var parts = new List<object>();
        if (string.IsNullOrEmpty(path)) return parts;
        var i = path.StartsWith('$') ? 1 : 0;
        while (i < path.Length)
        {
            if (path[i] == '.') { i++; continue; }
            if (path[i] == '[')
            {
                var end = path.IndexOf(']', i);
                if (end < 0) break;
                var inner = path[(i + 1)..end];
                parts.Add(int.TryParse(inner, NumberStyles.None, CultureInfo.InvariantCulture, out var ix) ? ix : inner.Trim('\'', '"'));
                i = end + 1;
                continue;
            }
            var next = i;
            while (next < path.Length && path[next] != '.' && path[next] != '[') next++;
            parts.Add(path[i..next]);
            i = next;
        }
        return parts;
    }

    // The CLR type at the end of a wire path below <paramref name="root"/>; null once it cannot be followed.
    private static Type? ResolveType(Type? root, IEnumerable<object> path)
    {
        var type = root;
        foreach (var step in path)
        {
            if (type is null) return null;
            type = Nullable.GetUnderlyingType(type) ?? type;
            if (step is int)
            {
                type = ElementType(type);
                continue;
            }
            if (typeof(IDictionary).IsAssignableFrom(type)) { type = type.IsGenericType ? type.GetGenericArguments()[^1] : null; continue; }
            var name = (string)step;
            type = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(p => string.Equals(WireName(p, null), name, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))?.PropertyType;
        }
        return type;
    }

    private static Type? ElementType(Type type) =>
        type.IsArray ? type.GetElementType()
        : type.IsGenericType ? type.GetGenericArguments()[0]
        : null;

    /// <summary>The wire name of a property: its [JsonPropertyName], else the options' naming policy, else the CLR name.</summary>
    public static string WireName(PropertyInfo property, JsonSerializerOptions? options)
    {
        if (property.GetCustomAttribute<JsonPropertyNameAttribute>() is { } named) return named.Name;
        return (options is null ? JsonNamingPolicy.CamelCase : options.PropertyNamingPolicy)?.ConvertName(property.Name) ?? property.Name;
    }

    /// <summary>The wire name of the CLR property <paramref name="clrName"/> of <paramref name="owner"/>.</summary>
    public static string WireName(Type owner, string clrName, JsonSerializerOptions? options) =>
        owner.GetProperty(clrName) is { } property ? WireName(property, options) : clrName;

    /// <summary>
    /// Evaluate every DataAnnotations attribute of every property of <paramref name="instance"/>, recording one
    /// issue per failing attribute at <c>prefix + wireName</c>. Class-level attributes and IValidatableObject
    /// are honoured as a fallback when no property failed. Returns true when nothing failed.
    /// </summary>
    public bool ValidateObject(object instance, JsonSerializerOptions? options, params object[] prefix)
    {
        var before = Count;
        foreach (var property in instance.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.GetIndexParameters().Length != 0 || !property.CanRead) continue;
            ValidateProperty(instance, property, property.GetValue(instance), WireName(property, options), prefix);
        }
        if (Count != before) return false;
        var results = new List<ValidationResult>();
        if (Validator.TryValidateObject(instance, new ValidationContext(instance), results, validateAllProperties: true)) return true;
        foreach (var result in results)
            Add("custom", result.ErrorMessage ?? "invalid", [.. prefix, .. ResultPath(instance, result, options)]);
        return false;
    }

    private static IEnumerable<object> ResultPath(object instance, ValidationResult result, JsonSerializerOptions? options)
    {
        var member = result.MemberNames.FirstOrDefault(m => !string.IsNullOrEmpty(m));
        if (member is not null) yield return WireName(instance.GetType(), member, options);
    }

    /// <summary>
    /// Evaluate the DataAnnotations attributes of the property <paramref name="clrName"/> of
    /// <paramref name="owner"/> against <paramref name="value"/> (a PATCH validates only the present value,
    /// never the whole row), recording issues at <c>prefix + wireName</c>. Returns true when it is valid.
    /// </summary>
    public bool ValidateProperty(object owner, string clrName, object? value, JsonSerializerOptions? options, params object[] prefix)
    {
        var property = owner.GetType().GetProperty(clrName);
        if (property is null) return true;
        var before = Count;
        ValidateProperty(owner, property, value, WireName(property, options), prefix);
        return Count == before;
    }

    private void ValidateProperty(object owner, PropertyInfo property, object? value, string wire, object[] prefix)
    {
        foreach (var attribute in property.GetCustomAttributes<ValidationAttribute>(inherit: true))
        {
            var context = new ValidationContext(owner) { MemberName = property.Name, DisplayName = wire };
            var result = attribute.GetValidationResult(value, context);
            if (result is null || result == ValidationResult.Success) continue;
            Add(CodeFor(attribute, value), result.ErrorMessage ?? $"{wire} is invalid", [.. prefix, wire]);
        }
    }

    /// <summary>The Zod code for a DataAnnotations attribute that rejected <paramref name="value"/>.</summary>
    public static string CodeFor(ValidationAttribute attribute, object? value)
    {
        switch (attribute)
        {
            case RequiredAttribute:
                return "invalid_type";
            case MaxLengthAttribute:
                return "too_big";
            case MinLengthAttribute:
                return "too_small";
            case StringLengthAttribute sl:
                return Length(value) is { } n && n < sl.MinimumLength ? "too_small" : "too_big";
            case RangeAttribute range:
                return RangeSide(range, value);
            case EnumDataTypeAttribute:
                return "invalid_value";
            case RegularExpressionAttribute:
            case DataTypeAttribute:
                return "invalid_format";
            default:
                return "custom";
        }
    }

    private static int? Length(object? value) => value switch
    {
        string s => s.Length,
        Array a => a.Length,
        ICollection c => c.Count,
        _ => null,
    };

    // Which bound a value crossed: below the minimum is too_small, above the maximum too_big.
    private static string RangeSide(RangeAttribute range, object? value)
    {
        try
        {
            var converter = System.ComponentModel.TypeDescriptor.GetConverter(range.OperandType);
            object Operand(object bound) => bound is string s
                ? converter.ConvertFromString(null, CultureInfo.InvariantCulture, s)!
                : Convert.ChangeType(bound, range.OperandType, CultureInfo.InvariantCulture);
            var v = value is string text
                ? converter.ConvertFromString(null, CultureInfo.InvariantCulture, text)
                : Convert.ChangeType(value, range.OperandType, CultureInfo.InvariantCulture);
            if (v is IComparable comparable)
            {
                if (comparable.CompareTo(Operand(range.Minimum)) < 0) return "too_small";
                if (comparable.CompareTo(Operand(range.Maximum)) > 0) return "too_big";
            }
        }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException or NotSupportedException or ArgumentException)
        {
            // not comparable: fall through
        }
        return "custom";
    }
}
