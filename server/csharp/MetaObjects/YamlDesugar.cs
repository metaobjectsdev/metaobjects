// YamlDesugar — YAML authoring → canonical-JSON desugar (ADR-0006).
//
// C# port of:
//   server/typescript/packages/metadata/src/core/yaml-desugar.ts (reference)
//   server/python/src/metaobjects/yaml_desugar.py (sibling)
//   server/java/metadata/src/main/java/com/metaobjects/loader/parser/yaml/YamlDesugar.java (sibling)
//
// Turns the sugared authoring object (a YamlDotNet YamlNode tree) into a canonical-
// JSON-shaped JsonObject that the existing canonical Parser can consume.
//
// Four format-spec sugar rules:
//   1. Fused key, subType omittable — a bare `type` key resolves to the type's
//      registry default subType.
//   2. Scalar-or-map body — a scalar body becomes { name: <scalar> }; null → {}.
//   3. `[]` arrays — a trailing `[]` on the key strips to isArray: true.
//   4. Sigil-free attributes (ADR-0006 D1) — every body key not in RESERVED_KEYS
//      is treated as an inline attribute and re-prefixed with `@` when lowering
//      to canonical JSON. Keys already prefixed with `@` are kept as-authored.
//      An already-`@`-prefixed reserved word remains an error downstream —
//      the canonical Parser's ERR_RESERVED_ATTR check fires.
//
// Plus the ADR-0006 D2 type-coercion guard: for every inline attr whose owning
// (type, subType) has a declared schema, if the raw value's type doesn't match
// the declared valueType AND the value is one of YAML 1.2's silently coerced
// shapes (bool/number/null), the desugar collects an ERR_YAML_COERCION error
// telling the author to quote the value.
//
// Pure and total: it never throws. Malformed fragments are collected as
// CollectedError entries and a safe placeholder is substituted so the canonical
// Parser does not double-report.

using System.Text.Json.Nodes;
using MetaObjects.Source;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace MetaObjects;

// ---------------------------------------------------------------------------
// Collected error + result types
// ---------------------------------------------------------------------------

/// <summary>
/// A collected desugar problem — message plus optional stable error code.
/// An absent code maps to <see cref="ErrorCode.ERR_MALFORMED_YAML"/> in <see cref="ParserYaml"/>.
/// </summary>
public sealed record YamlCollectedError(string Message, ErrorCode? Code = null);

/// <summary>Outcome of desugaring a parsed-YAML document.</summary>
public sealed record YamlDesugarResult(
    JsonObject Canonical,
    IReadOnlyList<YamlCollectedError> Errors);

// ---------------------------------------------------------------------------
// YamlDesugar
// ---------------------------------------------------------------------------

/// <summary>
/// Lowers a YamlDotNet representation tree to a canonical-JSON-shaped
/// <see cref="JsonObject"/>. Pure and total.
/// </summary>
public static class YamlDesugar
{
    /// <summary>The `[]` suffix on a body key — strips to <c>isArray: true</c>.</summary>
    public const string ARRAY_SUFFIX = "[]";

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    /// <summary>
    /// Desugar a parsed-YAML authoring document into a canonical-shaped
    /// <see cref="JsonObject"/>. Never throws; malformed fragments are collected.
    /// </summary>
    public static YamlDesugarResult Desugar(YamlNode? input, TypeRegistry registry)
    {
        var errors = new List<YamlCollectedError>();
        JsonObject? node = DesugarNode(input, registry, errors, "<root>");
        return new YamlDesugarResult(node ?? new JsonObject(), errors.AsReadOnly());
    }

    // -----------------------------------------------------------------------
    // Node-level desugar
    // -----------------------------------------------------------------------

    /// <summary>
    /// Desugar one node — a single-key mapping { "type.subType": body }.
    /// Returns the canonical node object, or null if input is not a usable node.
    /// </summary>
    private static JsonObject? DesugarNode(
        YamlNode? input,
        TypeRegistry registry,
        List<YamlCollectedError> errors,
        string path)
    {
        if (input is null)
        {
            errors.Add(new YamlCollectedError(
                $"Node at {path} must be a mapping with one type key"));
            return null;
        }
        if (input is not YamlMappingNode map)
        {
            errors.Add(new YamlCollectedError(
                $"Node at {path} must be a mapping with one type key"));
            return null;
        }

        if (map.Children.Count != 1)
        {
            string found;
            if (map.Children.Count == 0)
            {
                found = "none";
            }
            else
            {
                var keyStrs = new List<string>();
                foreach (var kvp in map.Children) keyStrs.Add(YamlNodeToString(kvp.Key));
                found = string.Join(", ", keyStrs);
            }
            errors.Add(new YamlCollectedError(
                $"Node at {path} must have exactly one type key (found: {found})"));
            return null;
        }

        var entry = map.Children.First();
        YamlNode rawKeyNode = entry.Key;
        if (rawKeyNode is not YamlScalarNode keyScalar || keyScalar.Value is null)
        {
            errors.Add(new YamlCollectedError(
                $"Node key at {path} must be a string"));
            return null;
        }
        string rawKey = keyScalar.Value;
        YamlNode rawBody = entry.Value;

        // FR5b — capture the wrapper-key's YAML position BEFORE any rewrites.
        // The author's raw key (with `[]` suffix and possibly omitted subType)
        // is at this (line, col); the desugar emits this position under the
        // CANONICAL key on the wrapper's position map.
        YamlPosition? wrapperKeyPos = null;
        Mark keyStart = keyScalar.Start;
        if (keyStart.Line > 0 || keyStart.Column > 0)
        {
            wrapperKeyPos = new YamlPosition((int)keyStart.Line, (int)keyStart.Column);
        }

        // Rule 3: a trailing "[]" on the key → isArray.
        string key = rawKey;
        bool isArray = false;
        if (key.EndsWith(ARRAY_SUFFIX, StringComparison.Ordinal))
        {
            key = key[..^ARRAY_SUFFIX.Length];
            isArray = true;
        }

        // Rule 1: a bare `type` key → the type's registry default subType.
        string canonicalKey = ResolveKey(key, registry, errors, path);

        // Rule 2: a scalar body → { name: <scalar> }.
        // FR5b — pass the wrapper-key position so the scalar-body synthesis
        // (Rule 2) can attribute the synthesized `name` slot to the wrapper.
        JsonObject body = DesugarBody(rawBody, registry, canonicalKey, errors, path, wrapperKeyPos);

        // Rule 3 (cont.): stamp isArray onto the canonical body.
        if (isArray)
        {
            body[RESERVED_KEY_IS_ARRAY] = true;
        }

        // Recurse into children — when children is a YAML list, desugar each element.
        if (rawBody is YamlMappingNode bodyMap)
        {
            foreach (var bkvp in bodyMap.Children)
            {
                if (bkvp.Key is YamlScalarNode ks && ks.Value == RESERVED_KEY_CHILDREN)
                {
                    if (bkvp.Value is YamlSequenceNode seq)
                    {
                        var children = new JsonArray();
                        for (int i = 0; i < seq.Children.Count; i++)
                        {
                            string childPath = $"{path}.{RESERVED_KEY_CHILDREN}[{i}]";
                            JsonObject? child = DesugarNode(seq.Children[i], registry, errors, childPath);
                            children.Add(child ?? new JsonObject());
                        }
                        body[RESERVED_KEY_CHILDREN] = children;
                    }
                    // Non-sequence children left as-converted in DesugarBody; canonical
                    // parser reports the structural error.
                    break;
                }
            }
        }

        var wrapper = new JsonObject
        {
            [canonicalKey] = body,
        };
        // FR5b — stamp the wrapper-level position-by-key map (canonicalKey →
        // raw-key position). The single key transformation is rawKey → canonicalKey
        // (Rule 1 fuses the subType, Rule 3 strips `[]`); the YAML position is
        // unchanged. Flattened later by ParserYaml into a JSONPath-keyed lookup
        // for the canonical parser.
        if (wrapperKeyPos is YamlPosition wp)
        {
            var wrapperPositions = new PositionMap();
            wrapperPositions.Set(canonicalKey, wp);
            YamlPositions.SetMap(wrapper, wrapperPositions);
        }
        return wrapper;
    }

    /// <summary>Rule 1 — resolve a possibly-bare key to a fused <c>type.subType</c> token.</summary>
    private static string ResolveKey(
        string key,
        TypeRegistry registry,
        List<YamlCollectedError> errors,
        string path)
    {
        if (key.Contains(TYPE_SUBTYPE_SEPARATOR, StringComparison.Ordinal))
        {
            return key; // already fused
        }
        string? subType = registry.DefaultSubTypeOf(key);
        if (subType is null)
        {
            errors.Add(new YamlCollectedError(
                $"Cannot resolve subType for bare type key '{key}' at {path}" +
                $" — type '{key}' has no default subType; write the full 'type.subType'"));
            return key; // pass through; canonical parser reports the unknown type
        }
        return $"{key}{TYPE_SUBTYPE_SEPARATOR}{subType}";
    }

    // -----------------------------------------------------------------------
    // Body-level desugar (Rules 2, 4 + D2 type-coercion guard)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Rule 2 + 4 — normalize a node body into a canonical mapping.
    /// Reserved structural keys stay bare; every other key is `@`-prefixed.
    /// Keys already starting with `@` are kept as-authored.
    /// Also runs the D2 type-coercion guard.
    /// </summary>
    private static JsonObject DesugarBody(
        YamlNode? rawBody,
        TypeRegistry registry,
        string canonicalKey,
        List<YamlCollectedError> errors,
        string path,
        // FR5b — position of the WRAPPER key (the `field.string:` line). Used
        // to back-fill the `name` slot on Rule-2 scalar-body synthesis; for
        // mapping bodies, we read each body-key's own position from the
        // YAML AST (the per-kvp scan below).
        YamlPosition? wrapperKeyPos)
    {
        var output = new JsonObject();
        if (rawBody is null)
        {
            // An empty body (`field.string:` with nothing after) → an empty node.
            // No body-side positions; the wrapper carries the node's position.
            return output;
        }

        if (rawBody is YamlScalarNode scalar)
        {
            // Scalar (null in YAML maps to a scalar with .Value == null or "" depending
            // on style; safest to check for actual null-tagged scalars first).
            if (IsYamlNull(scalar))
            {
                return output;
            }
            output[RESERVED_KEY_NAME] = ScalarToJsonValue(scalar);
            // FR5b — the synthesized `{ name: rawBody }` has no YAML-side
            // counterpart; attribute the `name` slot to the wrapper-key's
            // position (the only YAML position that meaningfully belongs to
            // this Rule-2 synthesis). Matches TS yaml-desugar.ts:160-167.
            if (wrapperKeyPos is YamlPosition wp)
            {
                var pm = new PositionMap();
                pm.Set(RESERVED_KEY_NAME, wp);
                YamlPositions.SetMap(output, pm);
            }
            return output;
        }

        if (rawBody is YamlSequenceNode)
        {
            errors.Add(new YamlCollectedError(
                $"Node body at {path} must be a scalar or mapping, not a list"));
            return output;
        }

        if (rawBody is not YamlMappingNode src)
        {
            errors.Add(new YamlCollectedError(
                $"Node body at {path} must be a scalar or mapping"));
            return output;
        }

        // Map case — apply Rule 4 (sigil-free attrs) + Rule D2 (coercion guard).
        IReadOnlyDictionary<string, AttrSchema>? schemaIndex = BuildAttrSchemaIndex(registry, canonicalKey);

        // FR5b — translate body-key YAML positions across the sigil-free rewrite.
        // A bare `filterable` key in the source maps to `@filterable` in the canonical
        // body; the YAML position belongs to BOTH names (the author only wrote one).
        // We re-key the position map to match the canonical body's keys so the parser
        // can find each node's position via the canonical key. Matches TS
        // yaml-desugar.ts:222-244.
        PositionMap? outPositions = null;

        foreach (var kvp in src.Children)
        {
            if (kvp.Key is not YamlScalarNode keyScalar || keyScalar.Value is null)
            {
                errors.Add(new YamlCollectedError(
                    $"Body key at {path} must be a string"));
                continue;
            }
            string key = keyScalar.Value;
            YamlNode value = kvp.Value;

            // FR5b — capture this body-key's YAML position once; we re-attach it
            // under the rewritten output key below.
            YamlPosition? bodyKeyPos = null;
            Mark bodyKeyStart = keyScalar.Start;
            if (bodyKeyStart.Line > 0 || bodyKeyStart.Column > 0)
            {
                bodyKeyPos = new YamlPosition((int)bodyKeyStart.Line, (int)bodyKeyStart.Column);
            }

            string outKey;

            // KEY_CHILDREN is reserved but its sequence is recursed-into by the caller.
            // Copy the raw value here as a placeholder; the caller will replace it with
            // a JsonArray of desugared children.
            if (key == RESERVED_KEY_CHILDREN)
            {
                output[RESERVED_KEY_CHILDREN] = YamlToJsonNode(value);
                outKey = RESERVED_KEY_CHILDREN;
            }
            else if (RESERVED_KEYS.Contains(key) ||
                key.StartsWith(ATTR_PREFIX, StringComparison.Ordinal))
            {
                // Reserved structural key written bare, OR author-written `@<name>:`
                // form — pass through as-is. An `@`-prefixed RESERVED keyword (e.g.
                // "@isArray") is NOT caught here: the canonical parser owns
                // ERR_RESERVED_ATTR and emits it with the proper FR5a envelope
                // (format=json, jsonPath at the parent node). Mirrors TS
                // yaml-desugar.ts:197-203 and Java YamlDesugar.java:340-349.
                output[key] = YamlToJsonNode(value);
                outKey = key;
                if (key.StartsWith(ATTR_PREFIX, StringComparison.Ordinal))
                {
                    // D2 coercion guard also applies to author-written @-keys (the
                    // awkward form) — but only for non-reserved attr names.
                    string attrName = key[ATTR_PREFIX.Length..];
                    if (attrName != "" && !RESERVED_KEYS.Contains(attrName))
                    {
                        CheckCoercion(attrName, value, schemaIndex, errors, path);
                    }
                }
            }
            else
            {
                // Rule 4 — sigil-free attr: re-prefix with `@` when lowering to canonical.
                outKey = $"{ATTR_PREFIX}{key}";
                output[outKey] = YamlToJsonNode(value);
                CheckCoercion(key, value, schemaIndex, errors, path);
            }

            if (bodyKeyPos is YamlPosition bp)
            {
                outPositions ??= new PositionMap();
                outPositions.Set(outKey, bp);
            }
        }
        if (outPositions is not null && outPositions.Any)
        {
            YamlPositions.SetMap(output, outPositions);
        }
        return output;
    }

    // -----------------------------------------------------------------------
    // YAML → JsonNode conversion
    // -----------------------------------------------------------------------

    /// <summary>
    /// Convert a YamlNode to a <see cref="JsonNode"/> preserving YAML 1.2 core-schema
    /// types: scalars become typed JsonValue (string/bool/int/double/null), mappings
    /// become JsonObject, sequences become JsonArray.
    /// </summary>
    private static JsonNode? YamlToJsonNode(YamlNode node)
    {
        switch (node)
        {
            case YamlScalarNode scalar:
                return ScalarToJsonValue(scalar);
            case YamlSequenceNode seq:
                var arr = new JsonArray();
                foreach (var el in seq.Children) arr.Add(YamlToJsonNode(el));
                return arr;
            case YamlMappingNode map:
                var obj = new JsonObject();
                foreach (var kvp in map.Children)
                {
                    string k = kvp.Key is YamlScalarNode sk && sk.Value is not null
                        ? sk.Value
                        : kvp.Key.ToString() ?? "";
                    obj[k] = YamlToJsonNode(kvp.Value);
                }
                return obj;
            default:
                return null;
        }
    }

    /// <summary>
    /// Convert a YAML scalar to a typed JsonNode applying YAML 1.2 core-schema rules.
    /// Tag-aware: explicit !!str / !!bool / !!int / !!float tags win over the value form.
    /// </summary>
    private static JsonNode? ScalarToJsonValue(YamlScalarNode scalar)
    {
        // Explicit tag handling — !!str forces string, etc.
        string? tag = scalar.Tag.IsEmpty ? null : scalar.Tag.Value;
        string? raw = scalar.Value;

        if (tag == "tag:yaml.org,2002:null") return null;
        if (raw is null) return null;

        // Quoted scalars (style != Plain) are always strings.
        if (scalar.Style == YamlDotNet.Core.ScalarStyle.SingleQuoted
            || scalar.Style == YamlDotNet.Core.ScalarStyle.DoubleQuoted
            || scalar.Style == YamlDotNet.Core.ScalarStyle.Literal
            || scalar.Style == YamlDotNet.Core.ScalarStyle.Folded)
        {
            return JsonValue.Create(raw);
        }

        if (tag == "tag:yaml.org,2002:str") return JsonValue.Create(raw);
        if (tag == "tag:yaml.org,2002:bool") return ParseBool(raw) ?? JsonValue.Create(raw);
        if (tag == "tag:yaml.org,2002:int") return ParseInt(raw) ?? JsonValue.Create(raw);
        if (tag == "tag:yaml.org,2002:float") return ParseFloat(raw) ?? JsonValue.Create(raw);

        // Plain scalars — apply YAML 1.2 core schema.
        // Order matters: null/bool first, then int, then float, fallback string.
        if (raw == "" || raw == "~" || raw == "null" || raw == "Null" || raw == "NULL")
            return null;
        JsonNode? maybeBool = ParseBool(raw);
        if (maybeBool is not null) return maybeBool;
        JsonNode? maybeInt = ParseInt(raw);
        if (maybeInt is not null) return maybeInt;
        JsonNode? maybeFloat = ParseFloat(raw);
        if (maybeFloat is not null) return maybeFloat;
        return JsonValue.Create(raw);
    }

    private static bool IsYamlNull(YamlScalarNode scalar)
    {
        string? tag = scalar.Tag.IsEmpty ? null : scalar.Tag.Value;
        if (tag == "tag:yaml.org,2002:null") return true;
        if (scalar.Value is null) return true;
        // Plain (unquoted) null literals only — `"null"` is a string.
        if (scalar.Style != YamlDotNet.Core.ScalarStyle.Plain) return false;
        string raw = scalar.Value;
        return raw == "" || raw == "~" || raw == "null" || raw == "Null" || raw == "NULL";
    }

    private static JsonNode? ParseBool(string raw)
    {
        // YAML 1.2 core: true|True|TRUE → true; false|False|FALSE → false.
        if (raw == "true" || raw == "True" || raw == "TRUE") return JsonValue.Create(true);
        if (raw == "false" || raw == "False" || raw == "FALSE") return JsonValue.Create(false);
        return null;
    }

    private static JsonNode? ParseInt(string raw)
    {
        // Decimal integers only (YAML 1.2 core schema); leading + allowed.
        if (long.TryParse(raw, System.Globalization.NumberStyles.AllowLeadingSign,
            System.Globalization.CultureInfo.InvariantCulture, out long l))
        {
            // Avoid the float-shaped "1.0" being absorbed by Int64.TryParse (it isn't),
            // but reject scientific notation by ensuring no '.', 'e', or 'E'.
            if (!raw.Contains('.') && !raw.Contains('e') && !raw.Contains('E'))
            {
                return JsonValue.Create(l);
            }
        }
        return null;
    }

    private static JsonNode? ParseFloat(string raw)
    {
        // .inf/.nan/-.inf are YAML 1.2 core specials — preserved as JSON strings would
        // not be useful; map to JSON numbers where possible, otherwise leave to string.
        if (raw == ".inf" || raw == ".Inf" || raw == ".INF") return JsonValue.Create(double.PositiveInfinity);
        if (raw == "-.inf" || raw == "-.Inf" || raw == "-.INF") return JsonValue.Create(double.NegativeInfinity);
        if (raw == ".nan" || raw == ".NaN" || raw == ".NAN") return JsonValue.Create(double.NaN);

        if (double.TryParse(raw, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out double d))
        {
            // Only accept as float if it actually looks float-y (has '.' or exponent).
            if (raw.Contains('.') || raw.Contains('e') || raw.Contains('E'))
            {
                return JsonValue.Create(d);
            }
        }
        return null;
    }

    private static string YamlNodeToString(YamlNode node) =>
        node is YamlScalarNode s && s.Value is not null ? s.Value : node.ToString() ?? "";

    // -----------------------------------------------------------------------
    // D2 type-coercion guard
    // -----------------------------------------------------------------------

    /// <summary>
    /// Build a name → AttrSchema map of attr-declared children for the given
    /// canonical key. Returns null when the (type, subType) is not registered.
    /// </summary>
    private static IReadOnlyDictionary<string, AttrSchema>? BuildAttrSchemaIndex(
        TypeRegistry registry,
        string canonicalKey)
    {
        int dot = canonicalKey.IndexOf(TYPE_SUBTYPE_SEPARATOR, StringComparison.Ordinal);
        if (dot < 0) return null;
        string type = canonicalKey[..dot];
        string subType = canonicalKey[(dot + TYPE_SUBTYPE_SEPARATOR.Length)..];
        if (!registry.Has(type, subType)) return null;

        IReadOnlyList<AttrSchema> attrs = registry.AttrsOf(type, subType);
        if (attrs.Count == 0) return null;

        var idx = new Dictionary<string, AttrSchema>(StringComparer.Ordinal);
        foreach (AttrSchema spec in attrs)
        {
            // First-wins.
            if (!idx.ContainsKey(spec.Name)) idx[spec.Name] = spec;
        }
        return idx.Count == 0 ? null : idx;
    }

    /// <summary>
    /// Check a single attr value against its declared schema's <c>ValueType</c>.
    /// Emits ERR_YAML_COERCION when YAML 1.2's core schema silently changed the
    /// scalar type (bool/number/null where a string/stringarray was declared, or
    /// vice versa for booleans/numbers).
    /// </summary>
    private static void CheckCoercion(
        string attrName,
        YamlNode rawNode,
        IReadOnlyDictionary<string, AttrSchema>? schemaIndex,
        List<YamlCollectedError> errors,
        string path)
    {
        if (schemaIndex is null) return;
        if (!schemaIndex.TryGetValue(attrName, out AttrSchema? spec)) return;
        if (spec.ValueType is null) return;
        string declared = spec.ValueType;

        // Stringarray-typed attrs: bare-string-as-one-element shorthand is allowed.
        if (declared == ATTR_SUBTYPE_STRINGARRAY)
        {
            CheckArrayCoercion(attrName, rawNode, errors, path);
            return;
        }

        if (declared == ATTR_SUBTYPE_STRING || declared == ATTR_SUBTYPE_CLASS)
        {
            if (!IsYamlString(rawNode))
            {
                EmitCoercion(attrName, rawNode, "string", errors, path);
            }
            return;
        }
        if (declared == ATTR_SUBTYPE_BOOLEAN)
        {
            if (!IsYamlBoolean(rawNode))
            {
                EmitCoercion(attrName, rawNode, "boolean", errors, path);
            }
            return;
        }
        if (declared == ATTR_SUBTYPE_INT
            || declared == ATTR_SUBTYPE_LONG
            || declared == ATTR_SUBTYPE_DOUBLE)
        {
            if (!IsYamlNumber(rawNode))
            {
                EmitCoercion(attrName, rawNode, "number", errors, path);
            }
            return;
        }
        // Object-shaped attrs (properties, filter) — accept any object/array, no YAML
        // coercion path applies.
    }

    /// <summary>
    /// Array attr coercion check. A bare string at the value position is the legitimate
    /// one-element authoring shorthand for a string-array attr — NOT a coercion. A list
    /// is checked element-by-element.
    /// </summary>
    private static void CheckArrayCoercion(
        string attrName,
        YamlNode rawNode,
        List<YamlCollectedError> errors,
        string path)
    {
        // Bare string is the legitimate one-element authoring shorthand.
        if (IsYamlString(rawNode)) return;
        if (rawNode is not YamlSequenceNode seq)
        {
            EmitCoercion(attrName, rawNode, "string-array (or single string)", errors, path);
            return;
        }
        for (int i = 0; i < seq.Children.Count; i++)
        {
            YamlNode el = seq.Children[i];
            if (!IsYamlString(el))
            {
                EmitCoercion($"{attrName}[{i}]", el, "string (in string-array)", errors, path);
            }
        }
    }

    private static bool IsYamlString(YamlNode node)
    {
        if (node is not YamlScalarNode s || s.Value is null) return false;
        // Quoted scalars are always strings.
        if (s.Style == YamlDotNet.Core.ScalarStyle.SingleQuoted
            || s.Style == YamlDotNet.Core.ScalarStyle.DoubleQuoted
            || s.Style == YamlDotNet.Core.ScalarStyle.Literal
            || s.Style == YamlDotNet.Core.ScalarStyle.Folded)
            return true;
        string? tag = s.Tag.IsEmpty ? null : s.Tag.Value;
        if (tag == "tag:yaml.org,2002:str") return true;
        // Plain scalar — string only if it doesn't parse as another core type.
        if (IsYamlNull(s)) return false;
        if (ParseBool(s.Value) is not null) return false;
        if (ParseInt(s.Value) is not null) return false;
        if (ParseFloat(s.Value) is not null) return false;
        return true;
    }

    private static bool IsYamlBoolean(YamlNode node)
    {
        if (node is not YamlScalarNode s || s.Value is null) return false;
        // Quoted scalars are strings, never booleans.
        if (s.Style != YamlDotNet.Core.ScalarStyle.Plain)
        {
            string? tag2 = s.Tag.IsEmpty ? null : s.Tag.Value;
            return tag2 == "tag:yaml.org,2002:bool" && ParseBool(s.Value) is not null;
        }
        string? tag = s.Tag.IsEmpty ? null : s.Tag.Value;
        if (tag == "tag:yaml.org,2002:bool") return ParseBool(s.Value) is not null;
        if (tag is not null) return false; // explicit non-bool tag
        return ParseBool(s.Value) is not null;
    }

    private static bool IsYamlNumber(YamlNode node)
    {
        if (node is not YamlScalarNode s || s.Value is null) return false;
        // Quoted scalars are strings, never numbers.
        if (s.Style != YamlDotNet.Core.ScalarStyle.Plain)
        {
            string? tag2 = s.Tag.IsEmpty ? null : s.Tag.Value;
            return tag2 == "tag:yaml.org,2002:int" || tag2 == "tag:yaml.org,2002:float";
        }
        string? tag = s.Tag.IsEmpty ? null : s.Tag.Value;
        if (tag == "tag:yaml.org,2002:int") return ParseInt(s.Value) is not null;
        if (tag == "tag:yaml.org,2002:float") return ParseFloat(s.Value) is not null;
        if (tag is not null) return false;
        // Boolean must not pretend to be a number (YAML core has no overlap, but
        // be explicit for documentation parity with Java/Python).
        if (ParseBool(s.Value) is not null) return false;
        return ParseInt(s.Value) is not null || ParseFloat(s.Value) is not null;
    }

    // -----------------------------------------------------------------------
    // ERR_YAML_COERCION message formatting
    // -----------------------------------------------------------------------

    /// <summary>
    /// Build the "quote this value" error. The shape is intentionally explicit so AI
    /// authors can act on it: it identifies the attr, the (coerced) value, its YAML
    /// type, the declared expected type, and a one-line fix hint.
    /// </summary>
    private static void EmitCoercion(
        string attrName,
        YamlNode rawNode,
        string expected,
        List<YamlCollectedError> errors,
        string path)
    {
        string actualType = CoercedTypeName(rawNode);
        string literal = LiteralRepr(rawNode);
        errors.Add(new YamlCollectedError(
            $"Attribute '@{attrName}' at {path}: expected {expected}" +
            $" but got {actualType} ({literal}). " +
            $"YAML 1.2 silently coerced an unquoted value — quote it in YAML: " +
            $"'@{attrName}: \"{literal}\"' not '@{attrName}: {literal}'.",
            ErrorCode.ERR_YAML_COERCION));
    }

    private static string CoercedTypeName(YamlNode node)
    {
        if (node is YamlSequenceNode) return "array";
        if (node is YamlMappingNode) return "object";
        if (node is YamlScalarNode s)
        {
            if (IsYamlNull(s)) return "null";
            if (s.Style != YamlDotNet.Core.ScalarStyle.Plain) return "string";
            if (s.Value is null) return "null";
            if (ParseBool(s.Value) is not null) return "boolean";
            if (ParseInt(s.Value) is not null) return "number";
            if (ParseFloat(s.Value) is not null) return "number";
            return "string";
        }
        return "unknown";
    }

    private static string LiteralRepr(YamlNode node)
    {
        if (node is YamlScalarNode s && s.Value is not null) return s.Value;
        return node.ToString() ?? "";
    }
}

