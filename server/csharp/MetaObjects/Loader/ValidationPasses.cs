// ValidationPasses — stateless validation passes for the MetaDataLoader pipeline.
//
// Ported from three TypeScript files:
//   - typescript/packages/metadata/src/subtype-rules.ts
//   - typescript/packages/metadata/src/loader/validation-passes.ts
//   - typescript/packages/metadata/src/attr-schema-validate.ts
//
// Each method takes a fully-merged MetaData root (or registry) and returns
// errors / warnings. No loader state is read or written — pure functions.

using System.Text.RegularExpressions;
using MetaObjects.Meta;
using MetaObjects.Persistence.Source;
using MetaObjects.Source;

namespace MetaObjects.Loader;

/// <summary>
/// Stateless validation passes for the loader pipeline.
/// Called in order after super resolution, before freeze.
/// </summary>
public static class ValidationPasses
{
    // -------------------------------------------------------------------------
    // Result types
    // -------------------------------------------------------------------------

    public sealed record SubtypeRuleResult(
        IReadOnlyList<MetaError> Errors,
        IReadOnlyList<string> Warnings);

    public sealed record AttrSchemaValidationResult(
        IReadOnlyList<MetaError> Errors,
        IReadOnlyList<string> Warnings);

    // =========================================================================
    // Pass 2: ValidateSubtypeRules
    //   - value objects MUST NOT have a primary identity (error)
    //   - entity objects SHOULD have a primary identity, unless @isAbstract (warning)
    //   - base objects have no rule
    //
    // Ported from typescript/packages/metadata/src/subtype-rules.ts
    // =========================================================================

    public static SubtypeRuleResult ValidateSubtypeRules(MetaData root)
    {
        var errors = new List<MetaError>();
        var warnings = new List<string>();
        WalkSubtypeRules(root, errors, warnings);
        return new SubtypeRuleResult(errors.AsReadOnly(), warnings.AsReadOnly());
    }

    private static void WalkSubtypeRules(
        MetaData model,
        List<MetaError> errors,
        List<string> warnings)
    {
        if (model.Type == TYPE_OBJECT)
        {
            // Use Children() (effective) so inherited identities count.
            bool hasPrimary = model.Children().Any(
                c => c.Type == TYPE_IDENTITY &&
                     c.SubType == IDENTITY_SUBTYPE_PRIMARY);

            if (model.SubType == OBJECT_SUBTYPE_VALUE && hasPrimary)
            {
                errors.Add(new MetaError(
                    $"value object '{model.Fqn()}' must not have a primary identity " +
                    "(use subType: \"entity\" for records with identity)",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                    Envelope: model.Source));
            }
            else if (model.SubType == OBJECT_SUBTYPE_ENTITY &&
                     !hasPrimary &&
                     !model.IsAbstract)
            {
                warnings.Add(
                    $"entity object '{model.Fqn()}' has no primary identity " +
                    "(add an identity child or mark @isAbstract: true)");
            }
        }

        // Recurse into own children only (don't double-visit inherited nodes).
        foreach (var child in model.OwnChildren())
        {
            WalkSubtypeRules(child, errors, warnings);
        }
    }

    // =========================================================================
    // Pass 3: ValidateDataGridSortFields
    //   - @defaultSortField must name a field on the entity (use effective Children())
    //   - Error: ERR_BAD_DEFAULT_SORT_FIELD
    //
    // Ported from typescript/packages/metadata/src/loader/validation-passes.ts
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateDataGridSortFields(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var obj in root.OwnChildren()
                     .Where(c => c.Type == TYPE_OBJECT))
        {
            // Use Children() (effective) so inherited fields are visible when
            // validating @defaultSortField references.
            var effective = obj.Children();
            var fieldNames = new HashSet<string>(
                effective
                    .Where(c => c.Type == TYPE_FIELD)
                    .Select(f => f.Name),
                StringComparer.Ordinal);

            foreach (var layout in effective.Where(
                c => c.Type == TYPE_LAYOUT &&
                     c.SubType == LAYOUT_SUBTYPE_DATA_GRID))
            {
                var sortField = layout.OwnAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
                if (sortField is string sf && !fieldNames.Contains(sf))
                {
                    errors.Add(new MetaError(
                        $"dataGrid layout \"{layout.Name}\" on entity \"{obj.Name}\" " +
                        $"has @defaultSortField \"{sf}\" " +
                        $"but no such field exists on \"{obj.Name}\". " +
                        $"Available fields: {string.Join(", ", fieldNames)}",
                        ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD,
                        Envelope: layout.Source));
                }
            }
        }

        return errors.AsReadOnly();
    }

    // =========================================================================
    // Pass 4: ValidateFilterableHasIndex
    //   - @filterable: true field that is not part of any identity AND not
    //     @db.indexed: true → warning [filterable-without-index]
    //
    // Ported from typescript/packages/metadata/src/loader/validation-passes.ts
    // =========================================================================

    public static IReadOnlyList<string> ValidateFilterableHasIndex(MetaData root)
    {
        var warnings = new List<string>();

        foreach (var obj in root.OwnChildren()
                     .Where(c => c.Type == TYPE_OBJECT))
        {
            // Use Children() (effective) so inherited fields and identities are included.
            var effective = obj.Children();

            // Build the set of field names covered by any identity on this object.
            var indexedFieldNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var identity in effective.Where(c => c.Type == TYPE_IDENTITY))
            {
                var fields = identity.OwnAttr(IDENTITY_ATTR_FIELDS);
                if (fields is string singleField)
                {
                    // Bare string (pre-desugar): split on comma.
                    foreach (var part in singleField.Split(','))
                    {
                        indexedFieldNames.Add(part.Trim());
                    }
                }
                else if (fields is IReadOnlyList<string> fieldList)
                {
                    foreach (var name in fieldList)
                    {
                        indexedFieldNames.Add(name);
                    }
                }
                else if (fields is IReadOnlyList<object?> objList)
                {
                    // Defensive: handle object[] backing from the parser.
                    foreach (var item in objList)
                    {
                        if (item is string s) indexedFieldNames.Add(s);
                    }
                }
            }

            foreach (var field in effective.Where(c => c.Type == TYPE_FIELD))
            {
                var filterable = field.OwnAttr(FIELD_ATTR_FILTERABLE);
                if (filterable is not true) continue;
                if (field.OwnAttr(FIELD_ATTR_DB_INDEXED) is true) continue;
                if (indexedFieldNames.Contains(field.Name)) continue;

                warnings.Add(
                    $"[filterable-without-index] field \"{obj.Name}.{field.Name}\" has @filterable: true " +
                    "but is not part of any identity. Filtering on this field will sequential-scan. " +
                    "Add @db.indexed: true to the field (when supported), or remove @filterable: true.");
            }
        }

        return warnings.AsReadOnly();
    }

    // =========================================================================
    // Pass 5: ValidateOriginPaths
    //   - passthrough.@from / aggregate.@of must resolve to existing Entity.field
    //   - .@via must resolve through valid relationships, hopping entity-by-entity
    //     using each relationship's @objectRef
    //   - Error: ERR_INVALID_ORIGIN
    //
    // Ported from typescript/packages/metadata/src/loader/validation-passes.ts
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateOriginPaths(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var obj in root.OwnChildren()
                     .Where(c => c.Type == TYPE_OBJECT))
        {
            foreach (var field in obj.OwnChildren()
                         .Where(c => c.Type == TYPE_FIELD))
            {
                foreach (var origin in field.OwnChildren()
                             .Where(c => c.Type == TYPE_ORIGIN))
                {
                    if (origin.SubType == ORIGIN_SUBTYPE_PASSTHROUGH)
                    {
                        var from = origin.OwnAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
                        if (from is not string fromStr || fromStr == "")
                        {
                            // Missing-attr (not a reference resolution failure) —
                            // keep the node's own source envelope (json/yaml/merged).
                            errors.Add(new MetaError(
                                $"origin.passthrough on {obj.Name}.{field.Name}: missing @from.",
                                ErrorCode.ERR_INVALID_ORIGIN,
                                Envelope: origin.Source));
                            continue;
                        }
                        ValidateFromPath(fromStr, root, obj, field.Name, errors,
                            "origin.passthrough.@from", origin.Source);

                        var via = origin.OwnAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
                        if (via is string viaStr && viaStr != "")
                        {
                            ValidateViaPath(viaStr, root, obj, field.Name, errors, origin.Source);
                        }
                    }
                    else if (origin.SubType == ORIGIN_SUBTYPE_AGGREGATE)
                    {
                        var of = origin.OwnAttr(ORIGIN_AGGREGATE_ATTR_OF);
                        if (of is not string ofStr || ofStr == "")
                        {
                            // Missing-attr — keep origin's own source envelope.
                            errors.Add(new MetaError(
                                $"origin.aggregate on {obj.Name}.{field.Name}: missing @of.",
                                ErrorCode.ERR_INVALID_ORIGIN,
                                Envelope: origin.Source));
                            continue;
                        }
                        ValidateFromPath(ofStr, root, obj, field.Name, errors,
                            "origin.aggregate.@of", origin.Source);

                        var via = origin.OwnAttr(ORIGIN_AGGREGATE_ATTR_VIA);
                        if (via is not string viaStr || viaStr == "")
                        {
                            // Missing-attr — keep origin's own source envelope.
                            errors.Add(new MetaError(
                                $"origin.aggregate on {obj.Name}.{field.Name}: missing @via " +
                                "(aggregates require a relationship path).",
                                ErrorCode.ERR_INVALID_ORIGIN,
                                Envelope: origin.Source));
                            continue;
                        }
                        ValidateViaPath(viaStr, root, obj, field.Name, errors, origin.Source);
                    }
                }
            }
        }

        return errors.AsReadOnly();
    }

    // -------------------------------------------------------------------------
    // Origin helper: _findObject
    // -------------------------------------------------------------------------

    private static MetaData? FindObject(MetaData root, string name)
    {
        return root.OwnChildren()
            .FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == name);
    }

    // -------------------------------------------------------------------------
    // Origin helper: _findField
    // -------------------------------------------------------------------------

    private static MetaData? FindField(MetaData obj, string name)
    {
        // Use Children() so inherited fields (via extends) are included.
        return obj.Children()
            .FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == name);
    }

    // -------------------------------------------------------------------------
    // Origin helper: _findRelationship
    // -------------------------------------------------------------------------

    private static MetaData? FindRelationship(MetaData obj, string name)
    {
        // Use Children() so inherited relationships (via extends) are included.
        return obj.Children()
            .FirstOrDefault(c => c.Type == TYPE_RELATIONSHIP && c.Name == name);
    }

    // -------------------------------------------------------------------------
    // Origin helper: _validateFromPath
    // -------------------------------------------------------------------------

    private static void ValidateFromPath(
        string fromAttr,
        MetaData root,
        MetaData projection,
        string fieldName,
        List<MetaError> errors,
        string label,
        ErrorSource originSource)
    {
        string projectionName = projection.Name;
        // FR5d — referrer is `<projection-FQN>::<fieldName>` (the canonical
        // "where the broken reference lives" identifier).
        string referrer = $"{projection.Fqn()}::{fieldName}";

        int dotIdx = fromAttr.IndexOf('.', StringComparison.Ordinal);
        if (dotIdx < 1 || dotIdx == fromAttr.Length - 1)
        {
            // Malformed shape (not "Entity.field") — not a reference resolution
            // failure per se, but emit format=resolved with target=the bad string
            // so consumers see the same envelope shape across all FR5d sites.
            errors.Add(new MetaError(
                $"{label} \"{fromAttr}\" on {projectionName}.{fieldName}: " +
                "must be of form \"Entity.field\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                Envelope: ResolvedSource.From(originSource, referrer, fromAttr)));
            return;
        }

        string entityName = fromAttr[..dotIdx];
        string targetFieldName = fromAttr[(dotIdx + 1)..];

        var sourceObj = FindObject(root, entityName);
        if (sourceObj is null)
        {
            // FR5d — entity half of the ref didn't resolve. target = full ref.
            errors.Add(new MetaError(
                $"{label} \"{fromAttr}\" on {projectionName}.{fieldName}: " +
                $"no such entity \"{entityName}\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                Envelope: ResolvedSource.From(originSource, referrer, fromAttr)));
            return;
        }

        var sourceField = FindField(sourceObj, targetFieldName);
        if (sourceField is null)
        {
            // FR5d — entity resolved, field on it did not. target = full ref.
            errors.Add(new MetaError(
                $"{label} \"{fromAttr}\" on {projectionName}.{fieldName}: " +
                $"no such field \"{targetFieldName}\" on {entityName}.",
                ErrorCode.ERR_INVALID_ORIGIN,
                Envelope: ResolvedSource.From(originSource, referrer, fromAttr)));
        }
    }

    // -------------------------------------------------------------------------
    // Origin helper: _validateViaPath
    // -------------------------------------------------------------------------

    private static void ValidateViaPath(
        string viaAttr,
        MetaData root,
        MetaData projection,
        string fieldName,
        List<MetaError> errors,
        ErrorSource originSource)
    {
        string projectionName = projection.Name;
        // FR5d — referrer is `<projection-FQN>::<fieldName>`.
        string referrer = $"{projection.Fqn()}::{fieldName}";

        var segments = viaAttr.Split('.');
        if (segments.Length < 2)
        {
            errors.Add(new MetaError(
                $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                "must be of form \"Entity.relationship[.relationship...]\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                Envelope: ResolvedSource.From(originSource, referrer, viaAttr)));
            return;
        }

        string entityName = segments[0];
        var relSegments = segments.Skip(1).ToArray();

        var currentObj = FindObject(root, entityName);
        if (currentObj is null)
        {
            errors.Add(new MetaError(
                $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                $"no such entity \"{entityName}\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                Envelope: ResolvedSource.From(originSource, referrer, viaAttr)));
            return;
        }

        // FR5d — track the deepest-valid-prefix as we walk. The prefix grows
        // segment-by-segment; on a hop failure the error message names the
        // prefix that DID resolve, so authors can fix multi-hop typos quickly.
        // After the entity lookup above, the deepest valid prefix is just the
        // entity name; each successful relationship hop appends a segment.
        var validSegments = new List<string> { entityName };

        foreach (var relName in relSegments)
        {
            var rel = FindRelationship(currentObj, relName);
            if (rel is null)
            {
                string prefix = string.Join('.', validSegments);
                errors.Add(new MetaError(
                    $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                    $"no such relationship \"{relName}\" on {currentObj.Name}. " +
                    $"Deepest valid prefix was \"{prefix}\".",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    Envelope: ResolvedSource.From(originSource, referrer, viaAttr)));
                return;
            }

            var refTarget = rel.OwnAttr(RELATIONSHIP_ATTR_OBJECT_REF);
            if (refTarget is not string refStr || refStr == "")
            {
                errors.Add(new MetaError(
                    $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                    $"relationship \"{relName}\" on {currentObj.Name} is missing @objectRef.",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    Envelope: ResolvedSource.From(originSource, referrer, viaAttr)));
                return;
            }

            var nextObj = FindObject(root, refStr);
            if (nextObj is null)
            {
                // FR5d — relationship's @objectRef points at a missing entity.
                // target = the bad @objectRef value (NOT the full via path).
                errors.Add(new MetaError(
                    $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                    $"relationship \"{relName}\" points to non-existent entity \"{refStr}\".",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    Envelope: ResolvedSource.From(originSource, referrer, refStr)));
                return;
            }

            validSegments.Add(relName);
            currentObj = nextObj;
        }
    }

    // =========================================================================
    // Pass 6: ValidateAttrSchema
    //   Three checks per node:
    //   1. Required attrs present (use effective Attrs())
    //   2. Declared own attrs well-typed (use own OwnAttrs())
    //   3. allowedValues membership on declared own attrs
    //   Undeclared attrs are NOT flagged (open policy).
    //
    // Ported from typescript/packages/metadata/src/attr-schema-validate.ts
    // =========================================================================

    public static AttrSchemaValidationResult ValidateAttrSchema(
        MetaData root,
        TypeRegistry registry)
    {
        var errors = new List<MetaError>();
        var reportedConflicts = new HashSet<string>(StringComparer.Ordinal);
        WalkAttrSchema(root, registry, errors, reportedConflicts);
        return new AttrSchemaValidationResult(errors.AsReadOnly(), []);
    }

    // =========================================================================
    // Pass 7: ValidateDataGridFilterValues
    //   - @filter over a non-@filterable field → ERR_BAD_ATTR_FILTER
    //   - @filter uses a disallowed op for the field subtype → ERR_BAD_ATTR_FILTER
    //
    // Runs after extends: resolution (so inherited @filterable fields are visible)
    // and after parse-time desugaring (every clause is canonical { op: value }).
    //
    // Ported from typescript/packages/metadata/src/loader/validation-passes.ts
    // validateDataGridFilterValues + checkFilterClauses.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateDataGridFilterValues(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var obj in root.OwnChildren()
                     .Where(c => c.Type == TYPE_OBJECT))
        {
            // Use Children() (effective) so inherited @filterable fields are visible.
            var effective = obj.Children();

            // Build allowlist: field name → allowed ops for its subtype.
            var allow = new Dictionary<string, string[]>(StringComparer.Ordinal);
            foreach (var f in effective.Where(c => c.Type == TYPE_FIELD))
            {
                if (f.OwnAttr(FIELD_ATTR_FILTERABLE) is true)
                {
                    allow[f.Name] = OpsForSubType(f.SubType);
                }
            }

            foreach (var layout in effective.Where(
                c => c.Type == TYPE_LAYOUT &&
                     c.SubType == LAYOUT_SUBTYPE_DATA_GRID))
            {
                var filter = layout.OwnAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
                // Type errors (e.g. legacy string form) are reported by ValidateAttrSchema.
                if (filter is not IReadOnlyDictionary<string, object?> filterObj) continue;
                CheckFilterClauses(filterObj, allow, obj.Name, layout.Name, errors, layout.Source);
            }
        }

        return errors.AsReadOnly();
    }

    private static void CheckFilterClauses(
        IReadOnlyDictionary<string, object?> filter,
        Dictionary<string, string[]> allow,
        string entityName,
        string layoutName,
        List<MetaError> errors,
        ErrorSource layoutSource)
    {
        foreach (var (key, clause) in filter)
        {
            if (key == FILTER_COMPOSE_OR || key == FILTER_COMPOSE_AND)
            {
                if (clause is IReadOnlyList<object?> subList)
                {
                    foreach (var sub in subList)
                    {
                        if (sub is IReadOnlyDictionary<string, object?> subFilter)
                            CheckFilterClauses(subFilter, allow, entityName, layoutName, errors, layoutSource);
                    }
                }
                continue;
            }

            if (!allow.TryGetValue(key, out var allowedOps))
            {
                errors.Add(new MetaError(
                    $"dataGrid layout \"{layoutName}\" on entity \"{entityName}\" has @filter over " +
                    $"non-filterable field \"{key}\". Filterable fields: " +
                    $"{(allow.Count > 0 ? string.Join(", ", allow.Keys) : "(none)")}",
                    ErrorCode.ERR_BAD_ATTR_FILTER,
                    Envelope: layoutSource));
                continue;
            }

            // After parse-time desugaring, every non-composition field clause is
            // canonical { op: value }. The object guard below is defensive.
            if (clause is IReadOnlyDictionary<string, object?> clauseObj)
            {
                foreach (var op in clauseObj.Keys)
                {
                    if (!allowedOps.Contains(op))
                    {
                        errors.Add(new MetaError(
                            $"dataGrid layout \"{layoutName}\" on entity \"{entityName}\" @filter uses disallowed " +
                            $"op \"{key}.{op}\". Allowed ops for \"{key}\": {string.Join(", ", allowedOps)}",
                            ErrorCode.ERR_BAD_ATTR_FILTER,
                            Envelope: layoutSource));
                    }
                }
            }
        }
    }

    private static void WalkAttrSchema(
        MetaData node,
        TypeRegistry registry,
        List<MetaError> errors,
        HashSet<string> reportedConflicts)
    {
        ValidateAttrSchemaNode(node, registry, errors, reportedConflicts);
        foreach (var child in node.OwnChildren())
        {
            WalkAttrSchema(child, registry, errors, reportedConflicts);
        }
    }

    private static string NodeLabel(MetaData node)
    {
        string head = $"{node.Type}.{node.SubType}";
        return node.Name != "" ? $"{head} '{node.Name}'" : head;
    }

    private static void ValidateAttrSchemaNode(
        MetaData node,
        TypeRegistry registry,
        List<MetaError> errors,
        HashSet<string> reportedConflicts)
    {
        var perType = registry.AttrsOf(node.Type, node.SubType);
        var common  = registry.GetCommonAttrs();

        // Build the effective schema (per-type wins on name collision, common fills
        // the rest) and surface common-vs-per-type collisions in the same pass —
        // a name in both lists means a provider tried to overload a declared attr.
        var byName = new Dictionary<string, AttrSchema>(perType.Count + common.Count, StringComparer.Ordinal);
        foreach (var spec in perType) byName[spec.Name] = spec;

        var typeKey = $"{node.Type}.{node.SubType}";
        foreach (var ca in common)
        {
            if (byName.ContainsKey(ca.Name))
            {
                if (reportedConflicts.Add(typeKey))
                {
                    errors.Add(new MetaError(
                        $"Common attr '{ca.Name}' conflicts with per-type attr on {typeKey}",
                        ErrorCode.ERR_PROVIDER_ATTR_CONFLICT,
                        Envelope: node.Source));
                }
                continue; // per-type wins
            }
            byName[ca.Name] = ca;
        }

        if (byName.Count == 0) return;

        // --- Check 1: required attrs present ---
        // Use Attrs() (effective = own + inherited) so a node that legitimately
        // inherits a required attr from its super is not flagged as missing it.
        var effective = node.Attrs();
        foreach (var spec in byName.Values)
        {
            if (spec.Required && !effective.ContainsKey(spec.Name))
            {
                errors.Add(new MetaError(
                    $"{NodeLabel(node)} is missing required attribute '@{spec.Name}'",
                    ErrorCode.ERR_MISSING_REQUIRED_ATTR,
                    Envelope: node.Source));
            }
        }

        // --- Checks 2 + 3: declared own attrs are well-typed + in range ---
        foreach (var (attrName, value) in node.OwnAttrs())
        {
            if (!byName.TryGetValue(attrName, out var spec)) continue; // open policy

            // Check 2: value runtime type matches the declared valueType.
            // When valueType is absent (declared-but-untyped, e.g. @default), skip type check.
            if (spec.ValueType is not null && !ValueMatchesType(value, spec.ValueType))
            {
                errors.Add(new MetaError(
                    $"{NodeLabel(node)} attribute '@{attrName}' must be of type " +
                    $"'{spec.ValueType}' but got {RuntimeTypeName(value)}",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    Envelope: node.Source));
                // Skip allowedValues check when type is already wrong.
                continue;
            }

            // Check 3: allowedValues membership.
            if (spec.AllowedValues is { Count: > 0 } allowed)
            {
                if (!allowed.Any(av => Equals(av, value)))
                {
                    errors.Add(new MetaError(
                        $"{NodeLabel(node)} attribute '@{attrName}' has value " +
                        $"'{value}' which is not one of the allowed values: " +
                        $"{string.Join(", ", allowed.Select(v => v?.ToString() ?? "null"))}",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        Envelope: node.Source));
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Attr-type check helper — mirrors valueMatchesType() in attr-schema-validate.ts
    //
    // Numeric attr subtypes (int / long / double) map to either long or double
    // in C# (the parser stores JSON numbers as long when integral, double when
    // fractional). String, class → value is string. Boolean → bool.
    // stringarray → IReadOnlyList<string> (parser desugars bare strings).
    // properties, filter → object-shaped (IReadOnlyDictionary<string, object?>).
    // base or anything unexpected → accept anything.
    // -------------------------------------------------------------------------

    private static bool ValueMatchesType(object? value, string valueType)
    {
        return valueType switch
        {
            ATTR_SUBTYPE_STRING or
            ATTR_SUBTYPE_CLASS => value is string,

            ATTR_SUBTYPE_INT or
            ATTR_SUBTYPE_LONG => value is long or int,

            ATTR_SUBTYPE_DOUBLE => value is double or float or long or int,

            ATTR_SUBTYPE_BOOLEAN => value is bool,

            ATTR_SUBTYPE_STRINGARRAY =>
                // Must be a real string list; the parser already desugared bare strings.
                value is IReadOnlyList<string> ||
                (value is IReadOnlyList<object?> ol && ol.All(e => e is string)),

            ATTR_SUBTYPE_PROPERTIES or
            ATTR_SUBTYPE_FILTER =>
                // Object-typed attrs must be a dictionary (not string, not array).
                // A string @filter value is the legacy form → fails this check → ERR_BAD_ATTR_VALUE.
                value is IReadOnlyDictionary<string, object?>,

            _ => true, // SUBTYPE_BASE or unknown → accept anything
        };
    }

    private static string RuntimeTypeName(object? value)
    {
        return value switch
        {
            null => "null",
            IReadOnlyList<string> => "array",
            IReadOnlyList<object?> => "array",
            IReadOnlyDictionary<string, object?> => "object",
            string => "string",
            bool => "boolean",
            long or int => "number",
            double or float => "number",
            _ => value.GetType().Name,
        };
    }

    // =========================================================================
    // Pass: ValidateOnePrimarySource (source-v2, ADR-0007)
    //   An object that declares ≥1 source children MUST have exactly one whose
    //   effective role is "primary":
    //     0 sources           → OK (object is not persisted; no rule to enforce).
    //     1+ sources, 1 primary → OK
    //     1+ sources, 0 primary → ERR_SOURCE_NO_PRIMARY
    //     1+ sources, 2+ primary → ERR_SOURCE_MULTIPLE_PRIMARY
    //
    //   Own-only: only direct MetaSource children of the object are counted —
    //   inheriting "primary" status across extends would silently disable the
    //   author's ability to introduce a write-through projection.
    //
    //   Ported from typescript/packages/metadata/src/persistence/source/validate-source-roles.ts
    //   and Java loader/ValidationPhase#validateOnePrimarySource.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateOnePrimarySource(MetaData root)
    {
        var errors = new List<MetaError>();
        WalkOnePrimarySource(root, errors);
        return errors.AsReadOnly();
    }

    private static void WalkOnePrimarySource(MetaData node, List<MetaError> errors)
    {
        if (node is MetaObject obj)
        {
            ValidateObjectPrimarySource(obj, errors);
        }
        // Recurse into own children — handles nested objects (e.g. value objects).
        foreach (var child in node.OwnChildren())
        {
            WalkOnePrimarySource(child, errors);
        }
    }

    private static void ValidateObjectPrimarySource(MetaObject obj, List<MetaError> errors)
    {
        // Own-only MetaSource children.
        var sources = obj.OwnSources();
        if (sources.Count == 0)
        {
            // No sources declared — object is not persisted; rule does not apply.
            return;
        }

        int primaryCount = 0;
        foreach (var s in sources)
        {
            if (s.Role == SOURCE_ROLE_PRIMARY) primaryCount++;
        }

        if (primaryCount == 0)
        {
            errors.Add(new MetaError(
                $"object '{obj.Name}' declares {sources.Count} source(s) but none has role \"{SOURCE_ROLE_PRIMARY}\"",
                ErrorCode.ERR_SOURCE_NO_PRIMARY,
                Envelope: obj.Source));
        }
        else if (primaryCount > 1)
        {
            errors.Add(new MetaError(
                $"object '{obj.Name}' declares {primaryCount} sources with role \"{SOURCE_ROLE_PRIMARY}\"; exactly one is required",
                ErrorCode.ERR_SOURCE_MULTIPLE_PRIMARY,
                Envelope: obj.Source));
        }
    }

    // =========================================================================
    // Pass: ValidateSourcePhysicalNames (FR-016 / ADR-0018)
    //   Per-kind physical-name aliases on source.rdb. Each source.rdb may declare
    //   at most one of @table / @view / @materializedView / @proc / @function.
    //   The chosen alias must match the source's @kind, with one pre-1.0 legacy
    //   exception: @table is also accepted for non-table kinds, which emits
    //   WARN_LEGACY_PHYSICAL_NAME_ALIAS (loader accepts; canonical-serializer
    //   rewrites to the kind-matching alias).
    //
    //   Codes:
    //     ERR_BAD_ATTR_VALUE              — kind-aware alias set to "" (explicit empty).
    //     ERR_PHYSICAL_NAME_MULTIPLE      — two or more kind-aware aliases on one source.
    //     ERR_PHYSICAL_NAME_KIND_MISMATCH — alias other than @table set with a non-matching @kind.
    //     WARN_LEGACY_PHYSICAL_NAME_ALIAS — @table set with a non-table @kind (legacy spelling).
    // =========================================================================

    /// <summary>Result of the FR-016 physical-name validation pass.</summary>
    public sealed record PhysicalNameValidationResult(
        IReadOnlyList<MetaError> Errors,
        IReadOnlyList<LoaderWarning> Warnings);

    public static PhysicalNameValidationResult ValidateSourcePhysicalNames(MetaData root)
    {
        var errors = new List<MetaError>();
        var warnings = new List<LoaderWarning>();

        foreach (var obj in root.OwnChildren().Where(c => c.Type == TYPE_OBJECT))
        {
            var sources = obj.OwnChildren()
                .Where(c => c.Type == TYPE_SOURCE
                    && c.SubType == SourceConstants.SOURCE_SUBTYPE_RDB
                    && c is MetaSource)
                .Cast<MetaSource>();

            foreach (var source in sources)
            {
                // Empty-string check first — explicit "" is meaningless and an
                // authoring error regardless of which alias was used.
                foreach (var attr in SourceConstants.ALL_PHYSICAL_NAME_ALIASES)
                {
                    if (source.OwnAttr(attr) is string sv && sv == "")
                    {
                        errors.Add(new MetaError(
                            $"source.rdb on object \"{obj.Name}\" sets @{attr} to an empty string; " +
                            "physical name attrs require a non-empty value",
                            ErrorCode.ERR_BAD_ATTR_VALUE,
                            Envelope: source.Source));
                    }
                }

                var setAliases = SourceConstants.ALL_PHYSICAL_NAME_ALIASES
                    .Where(attr => source.OwnAttr(attr) is string v && v != "")
                    .ToList();

                if (setAliases.Count > 1)
                {
                    errors.Add(new MetaError(
                        $"source.rdb on object \"{obj.Name}\" declares multiple physical-name aliases (" +
                        string.Join(", ", setAliases.Select(a => "@" + a)) +
                        "); set exactly one",
                        ErrorCode.ERR_PHYSICAL_NAME_MULTIPLE,
                        Envelope: source.Source));
                    continue;
                }

                if (setAliases.Count == 0) continue;

                string chosenAlias = setAliases[0];
                SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND.TryGetValue(source.EffectiveKind, out var expectedAlias);

                if (chosenAlias == expectedAlias) continue;

                // Legacy: @table is permitted for non-table kinds with a warning.
                if (chosenAlias == SourceConstants.SOURCE_ATTR_TABLE)
                {
                    warnings.Add(new LoaderWarning(
                        Code: WarningCodes.WARN_LEGACY_PHYSICAL_NAME_ALIAS,
                        Message:
                            $"source.rdb on object \"{obj.Name}\" uses @table with @kind: \"{source.EffectiveKind}\"; " +
                            $"prefer the kind-matching alias @{expectedAlias} (ADR-0018)",
                        Source: source.Source));
                    continue;
                }

                // Any other mismatch is a hard error.
                errors.Add(new MetaError(
                    $"source.rdb on object \"{obj.Name}\" uses @{chosenAlias} with @kind: \"{source.EffectiveKind}\"; " +
                    $"@{chosenAlias} is only valid for @kind: \"{KindForAlias(chosenAlias)}\"",
                    ErrorCode.ERR_PHYSICAL_NAME_KIND_MISMATCH,
                    Envelope: source.Source));
            }
        }

        return new PhysicalNameValidationResult(errors.AsReadOnly(), warnings.AsReadOnly());
    }

    private static string KindForAlias(string alias)
    {
        foreach (var (kind, attr) in SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND)
        {
            if (attr == alias) return kind;
        }
        return "(unknown)";
    }

    // =========================================================================
    // Pass 10: ValidateEnumValues
    //   Enforces the three cross-language @values rules on every field.enum node:
    //     1. @values must be non-empty.
    //     2. Every member must match ENUM_MEMBER_PATTERN (identifier-safe).
    //     3. No duplicate members.
    //   Error: ERR_BAD_ATTR_VALUE for all three.
    //
    //   Note: Pass 6 (ValidateAttrSchema) already enforces that @values is
    //   present (Required: true → ERR_MISSING_REQUIRED_ATTR) and that it is a
    //   stringarray. This pass runs after that and handles the content rules.
    // =========================================================================

    private static readonly Regex EnumMemberRegex =
        new Regex(ENUM_MEMBER_PATTERN, RegexOptions.Compiled);

    public static IReadOnlyList<MetaError> ValidateEnumValues(MetaData root)
    {
        var errors = new List<MetaError>();
        WalkEnumValues(root, errors);
        return errors.AsReadOnly();
    }

    private static void WalkEnumValues(MetaData node, List<MetaError> errors)
    {
        if (node is MetaField { SubType: FIELD_SUBTYPE_ENUM } field)
        {
            // Own @values only — content rules apply per-field, not via extends: inheritance.
            var members = field.EnumValues;

            if (members is not null)
            {
                // Rule 1: non-empty.
                if (members.Count == 0)
                {
                    errors.Add(new MetaError(
                        $"field.enum '{field.Name}' @values must not be empty",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        Envelope: field.Source));
                }
                else
                {
                    // Rule 2: each member must match the identifier pattern.
                    foreach (var member in members)
                    {
                        if (!EnumMemberRegex.IsMatch(member))
                        {
                            errors.Add(new MetaError(
                                $"field.enum '{field.Name}' @values member \"{member}\" is not a valid identifier " +
                                $"(must match {ENUM_MEMBER_PATTERN})",
                                ErrorCode.ERR_BAD_ATTR_VALUE,
                                Envelope: field.Source));
                        }
                    }

                    // Rule 3: no duplicates.
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var member in members)
                    {
                        if (!seen.Add(member))
                        {
                            errors.Add(new MetaError(
                                $"field.enum '{field.Name}' @values contains duplicate member \"{member}\"",
                                ErrorCode.ERR_BAD_ATTR_VALUE,
                                Envelope: field.Source));
                            break; // one duplicate error per field is enough
                        }
                    }
                }
            }

            // Rule 4 (FR-011): the enum fallback attrs must be one of the field's @values.
            //
            // Both @coerceDefault (extract-time coercion fallback) and @default (absent-fill
            // member) name an enum member, so each must be a member of @values. This block is
            // already inside the field.enum gate, so @default here is the enum-member default —
            // NOT the polymorphic column default on string/int/bool/etc. fields, which is never
            // member-checked.
            //
            // Only validate when THIS node owns the attr (own-attrs-only policy, matching the
            // @values rules above). The membership set is the EFFECTIVE @values — own or
            // inherited via extends: — so a concrete enum that owns the fallback attr and
            // inherits @values from an abstract super still validates correctly.
            foreach (var attrName in new[] { FIELD_ATTR_COERCE_DEFAULT, FIELD_ATTR_DEFAULT })
            {
                if (field.OwnAttr(attrName) is string ownValue)
                {
                    var effective = field.EffectiveEnumValues ?? new List<string>();
                    if (!effective.Contains(ownValue, StringComparer.Ordinal))
                    {
                        errors.Add(new MetaError(
                            $"field.enum '{field.Name}' attribute '@{attrName}' value " +
                            $"'{ownValue}' is not one of '@{FIELD_ATTR_VALUES}': {string.Join(", ", effective)}.",
                            ErrorCode.ERR_BAD_ATTR_VALUE,
                            Envelope: field.Source));
                    }
                }
            }
        }

        foreach (var child in node.OwnChildren())
            WalkEnumValues(child, errors);
    }

    // =========================================================================
    // Pass 10b: ValidateFieldDefaults (Phase B — generalized @default per-type)
    //
    // The @default attribute is registered on the field base, so any field subtype may
    // declare it. Its string value must coerce to the field's type:
    //   - int / long / currency       → integer parse (or finite-number truncation)
    //   - double / float / decimal     → finite-number parse
    //   - boolean                      → true|false (exact)
    //   - enum                         → member of @values (handled by ValidateEnumValues Rule 4)
    //   - string / date / time / others → any (no validation)
    // A violation emits ERR_BAD_ATTR_VALUE, mirroring the enum @default membership check.
    //
    // Own-only: validates @default declared on THIS node, matching the @values / FR-011 own-attr
    // passes. Numeric gates are ASCII-only (CultureInfo.InvariantCulture / NumberStyles without
    // AllowThousands) to match the Java/Python ports exactly — no "1_000"-style separators.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateFieldDefaults(MetaData root)
    {
        var errors = new List<MetaError>();
        WalkFieldDefaults(root, errors);
        return errors.AsReadOnly();
    }

    private static void WalkFieldDefaults(MetaData node, List<MetaError> errors)
    {
        if (node is MetaField field
            && field.SubType != FIELD_SUBTYPE_ENUM   // enum @default membership: ValidateEnumValues Rule 4
            && field.OwnAttr(FIELD_ATTR_DEFAULT) is { } rawDefault)
        {
            // @default is declared-but-untyped (ValueType: null), so the parser stores the raw
            // JSON value type-preserved: a JSON true/false → bool, a JSON number → long/double,
            // a JSON string → string. Stringify to the canonical form Java's getValueAsString
            // produces (lower-case bool, invariant-culture number) before the per-type gate.
            string def = StringifyDefault(rawDefault);
            bool ok = field.SubType switch
            {
                FIELD_SUBTYPE_INT or FIELD_SUBTYPE_LONG or FIELD_SUBTYPE_CURRENCY => ParsesAsLong(def),
                FIELD_SUBTYPE_DOUBLE or FIELD_SUBTYPE_FLOAT or FIELD_SUBTYPE_DECIMAL => ParsesAsFiniteNumber(def),
                FIELD_SUBTYPE_BOOLEAN => def == "true" || def == "false",
                _ => true,   // string / date / time / object / others — any value allowed
            };

            if (!ok)
            {
                errors.Add(new MetaError(
                    $"field.{field.SubType} '{field.Name}' @{FIELD_ATTR_DEFAULT} '{def}' " +
                    "is not coercible to the field's type",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    Envelope: field.Source));
            }
        }

        foreach (var child in node.OwnChildren())
            WalkFieldDefaults(child, errors);
    }

    /// <summary>
    /// Canonical string form of a type-preserved <c>@default</c> value, matching Java's
    /// <c>getValueAsString</c>: a bool lowercases to <c>true</c>/<c>false</c>; a number renders
    /// invariant-culture; a string passes through; null becomes the empty string.
    /// </summary>
    private static string StringifyDefault(object value) => value switch
    {
        string s => s,
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => value.ToString() ?? "",
    };

    /// <summary>
    /// ASCII-only integer gate (Java parity): an integer parse, or a finite decimal that
    /// truncates to an integer (matches the engine's <c>Coerce.Scalar</c> INT/LONG fallback).
    /// Uses <see cref="NumberStyles"/> without <c>AllowThousands</c> and InvariantCulture.
    /// </summary>
    private static bool ParsesAsLong(string s)
    {
        string t = s.Trim();
        if (long.TryParse(t, System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture, out _))
            return true;
        return double.TryParse(t, System.Globalization.NumberStyles.Float,
                   System.Globalization.CultureInfo.InvariantCulture, out double d)
               && double.IsFinite(d);
    }

    /// <summary>ASCII-only finite-number gate (Java parity): InvariantCulture, no thousands separator.</summary>
    private static bool ParsesAsFiniteNumber(string s) =>
        double.TryParse(s.Trim(), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out double d)
        && double.IsFinite(d);

    // =========================================================================
    // Pass 12: ValidateDbColumnType (R6 Plan 2b, ADR-0013)
    //   Own-only validation of the @dbColumnType physical column-type attribute,
    //   mirroring the field.enum @values precedent. Two rules:
    //
    //     1. The value must be one of the closed set uuid|jsonb|timestamp_with_tz
    //        → ERR_BAD_ATTR_VALUE otherwise.
    //     2. The (logical subtype × value) pairing must be legal:
    //          uuid              → field.string
    //          jsonb             → field.string
    //          timestamp_with_tz → field.timestamp
    //        → ERR_BAD_ATTR_VALUE on an illegal pairing.
    //
    //   The error message names the field, the value, and the legal set — matching
    //   the field.enum ERR_BAD_ATTR_VALUE precedent. Own-only: only @dbColumnType
    //   declared on THIS node is validated (a physical attr is never inherited via
    //   extends:). Cross-port: TS/Java/Python run the identical own-only check.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateDbColumnType(MetaData root)
    {
        var errors = new List<MetaError>();
        WalkDbColumnType(root, errors);
        return errors.AsReadOnly();
    }

    private static void WalkDbColumnType(MetaData node, List<MetaError> errors)
    {
        if (node is MetaField field && field.DbColumnType is { } value)
        {
            // Rule 1: recognized value.
            if (!VALID_DB_COLUMN_TYPES.Contains(value))
            {
                errors.Add(new MetaError(
                    $"field '{field.Name}' @{FIELD_ATTR_DB_COLUMN_TYPE} '{value}' is not a valid value; " +
                    $"allowed: {string.Join(", ", VALID_DB_COLUMN_TYPES)}",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    Envelope: field.Source));
            }
            else
            {
                // Rule 2: legal (subtype × value) pairing.
                var requiredSubType = value switch
                {
                    DB_COLUMN_TYPE_UUID or DB_COLUMN_TYPE_JSONB => FIELD_SUBTYPE_STRING,
                    DB_COLUMN_TYPE_TIMESTAMP_TZ => FIELD_SUBTYPE_TIMESTAMP,
                    _ => null, // unreachable (Rule 1)
                };
                if (requiredSubType is not null && field.SubType != requiredSubType)
                {
                    errors.Add(new MetaError(
                        $"field '{field.Name}' @{FIELD_ATTR_DB_COLUMN_TYPE} '{value}' is not valid on " +
                        $"field.{field.SubType} (requires field.{requiredSubType}); allowed pairings: " +
                        $"{DB_COLUMN_TYPE_UUID}→field.{FIELD_SUBTYPE_STRING}, " +
                        $"{DB_COLUMN_TYPE_JSONB}→field.{FIELD_SUBTYPE_STRING}, " +
                        $"{DB_COLUMN_TYPE_TIMESTAMP_TZ}→field.{FIELD_SUBTYPE_TIMESTAMP}",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        Envelope: field.Source));
                }
            }
        }

        foreach (var child in node.OwnChildren())
            WalkDbColumnType(child, errors);
    }

    // =========================================================================
    // Pass 8: ValidateFieldObjectStorage
    //   Cross-attribute validation for @storage on field.object:
    //     - @storage requires @objectRef on the same field → ERR_STORAGE_WITHOUT_OBJECT_REF
    //     - @storage "flattened" requires isArray=false (cannot flatten a
    //       variable-length array) → ERR_STORAGE_FLATTENED_ARRAY
    //
    // Ported from validateFieldObjectStorage in
    // typescript/packages/metadata/src/loader/validation-passes.ts.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateFieldObjectStorage(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var obj in root.OwnChildren().Where(c => c.Type == TYPE_OBJECT))
        {
            foreach (var field in obj.OwnChildren().Where(c => c.Type == TYPE_FIELD))
            {
                var storage = field.OwnAttr(FIELD_ATTR_STORAGE);
                if (storage is null) continue;

                var objectRef = field.OwnAttr(FIELD_ATTR_OBJECT_REF);
                if (objectRef is not string refStr || refStr.Length == 0)
                {
                    errors.Add(new MetaError(
                        $"field \"{obj.Name}.{field.Name}\" sets @storage but has no @objectRef",
                        ErrorCode.ERR_STORAGE_WITHOUT_OBJECT_REF,
                        Envelope: field.Source));
                }

                if (storage is string st && st == STORAGE_FLATTENED && field.IsArray)
                {
                    errors.Add(new MetaError(
                        $"field \"{obj.Name}.{field.Name}\" sets @storage \"flattened\" with isArray=true; " +
                        "flattened storage requires a single nested value",
                        ErrorCode.ERR_STORAGE_FLATTENED_ARRAY,
                        Envelope: field.Source));
                }
            }
        }

        return errors.AsReadOnly();
    }

    // =========================================================================
    // Pass 14 (FR-017): ValidateRelationships — M:N slim-vocabulary rules.
    //
    // Deferred-resolution validation (runs after all files load + extends:
    // resolution, like origin paths), enforcing the cross-port M:N contract.
    // Own-relationships only (matches the own-attrs policy of the other passes):
    //
    //   (a) @symmetric:true is valid only on a self-join (@objectRef == declaring
    //       entity). Otherwise ERR_BAD_ATTR_VALUE.
    //   (b) @symmetric and @sourceRefField are mutually exclusive -> ERR_BAD_ATTR_VALUE.
    //   (c) When @through is present (and the relationship is M:N): the named entity
    //       must exist and declare exactly two identity.reference children;
    //       @sourceRefField (if present) must match one of those references' FK
    //       fields -> ERR_INVALID_RELATIONSHIP.
    //   (d) @through / @sourceRefField / @symmetric are invalid on a non-M:N
    //       relationship (@cardinality != "many", or no @through) -> ERR_INVALID_RELATIONSHIP.
    //
    // Ported from validateRelationships in
    // typescript/packages/metadata/src/loader/validation-passes.ts.
    // =========================================================================

    /// <summary>FK field names declared by an entity's identity.reference children.</summary>
    private static List<string> JunctionReferenceFkFields(MetaData junction)
    {
        var output = new List<string>();
        foreach (var id in junction.OwnChildren())
        {
            if (id.Type != TYPE_IDENTITY || id.SubType != IDENTITY_SUBTYPE_REFERENCE) continue;
            var fields = id.OwnAttr(IDENTITY_ATTR_FIELDS);
            if (fields is string s)
            {
                var first = s.Split(',')[0].Trim();
                if (first.Length > 0) output.Add(first);
            }
            else if (fields is IReadOnlyList<string> list && list.Count > 0)
            {
                output.Add(list[0]);
            }
            else if (fields is IReadOnlyList<object?> objList && objList.Count > 0 && objList[0] is string os)
            {
                output.Add(os);
            }
        }
        return output;
    }

    private static int CountJunctionReferences(MetaData junction) =>
        junction.OwnChildren().Count(c => c.Type == TYPE_IDENTITY && c.SubType == IDENTITY_SUBTYPE_REFERENCE);

    /// <summary>Last <c>::</c>-segment of a (possibly package-qualified) name.</summary>
    private static string StripPackage(string name)
    {
        int idx = name.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        return idx < 0 ? name : name[(idx + PACKAGE_SEPARATOR.Length)..];
    }

    public static IReadOnlyList<MetaError> ValidateRelationships(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var obj in root.OwnChildren().Where(c => c.Type == TYPE_OBJECT))
        {
            foreach (var rel in obj.OwnChildren().Where(c => c.Type == TYPE_RELATIONSHIP))
            {
                var through = rel.OwnAttr(RELATIONSHIP_ATTR_THROUGH);
                var sourceRefField = rel.OwnAttr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
                bool symmetric = rel.OwnAttr(RELATIONSHIP_ATTR_SYMMETRIC) is true;
                var cardinality = rel.OwnAttr(RELATIONSHIP_ATTR_CARDINALITY);
                var objectRef = rel.OwnAttr(RELATIONSHIP_ATTR_OBJECT_REF);

                bool hasThrough = through is string ts && ts.Length > 0;
                bool hasSourceRefField = sourceRefField is string srs && srs.Length > 0;
                bool isMany = cardinality is string cs && cs == CARDINALITY_MANY;
                bool isM2M = hasThrough && isMany;

                // Rule (d): M:N-only attrs on a non-M:N relationship.
                if (!isM2M)
                {
                    if (hasThrough)
                    {
                        errors.Add(new MetaError(
                            $"relationship \"{obj.Name}.{rel.Name}\" sets @{RELATIONSHIP_ATTR_THROUGH} but is not a M:N " +
                            $"relationship (requires @{RELATIONSHIP_ATTR_CARDINALITY}: \"{CARDINALITY_MANY}\").",
                            ErrorCode.ERR_INVALID_RELATIONSHIP,
                            Envelope: rel.Source));
                    }
                    if (hasSourceRefField)
                    {
                        errors.Add(new MetaError(
                            $"relationship \"{obj.Name}.{rel.Name}\" sets @{RELATIONSHIP_ATTR_SOURCE_REF_FIELD} but is not a M:N relationship.",
                            ErrorCode.ERR_INVALID_RELATIONSHIP,
                            Envelope: rel.Source));
                    }
                    if (symmetric)
                    {
                        errors.Add(new MetaError(
                            $"relationship \"{obj.Name}.{rel.Name}\" sets @{RELATIONSHIP_ATTR_SYMMETRIC} but is not a M:N relationship.",
                            ErrorCode.ERR_INVALID_RELATIONSHIP,
                            Envelope: rel.Source));
                    }
                    continue;
                }

                // Rule (b): @symmetric and @sourceRefField are mutually exclusive.
                if (symmetric && hasSourceRefField)
                {
                    errors.Add(new MetaError(
                        $"relationship \"{obj.Name}.{rel.Name}\" sets both @{RELATIONSHIP_ATTR_SYMMETRIC} and " +
                        $"@{RELATIONSHIP_ATTR_SOURCE_REF_FIELD}; they are mutually exclusive.",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        Envelope: rel.Source));
                }

                // Rule (a): @symmetric is valid only on a self-join (@objectRef == declaring entity).
                bool isSelfJoin = objectRef is string objRefStr && StripPackage(objRefStr) == obj.Name;
                if (symmetric && !isSelfJoin)
                {
                    errors.Add(new MetaError(
                        $"relationship \"{obj.Name}.{rel.Name}\" sets @{RELATIONSHIP_ATTR_SYMMETRIC} but @{RELATIONSHIP_ATTR_OBJECT_REF} " +
                        $"\"{objectRef}\" is not the declaring entity \"{obj.Name}\"; @{RELATIONSHIP_ATTR_SYMMETRIC} is self-join-only.",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        Envelope: rel.Source));
                }

                // Rule (c): @through must name an entity declaring exactly two identity.reference children.
                var junction = FindObject(root, (string)through!);
                if (junction is null)
                {
                    errors.Add(new MetaError(
                        $"relationship \"{obj.Name}.{rel.Name}\" @{RELATIONSHIP_ATTR_THROUGH} \"{through}\" does not resolve to an entity.",
                        ErrorCode.ERR_INVALID_RELATIONSHIP,
                        Envelope: ResolvedSource.From(rel.Source, $"{obj.Fqn()}::{rel.Name}", (string)through!)));
                    continue;
                }
                int refCount = CountJunctionReferences(junction);
                if (refCount != 2)
                {
                    errors.Add(new MetaError(
                        $"relationship \"{obj.Name}.{rel.Name}\" @{RELATIONSHIP_ATTR_THROUGH} \"{through}\" must declare exactly two " +
                        $"identity.reference children (one per FK side); found {refCount}.",
                        ErrorCode.ERR_INVALID_RELATIONSHIP,
                        Envelope: rel.Source));
                    continue;
                }
                // @sourceRefField (if present) must match one of the junction's reference FK fields.
                if (hasSourceRefField)
                {
                    var fkFields = JunctionReferenceFkFields(junction);
                    if (!fkFields.Contains((string)sourceRefField!, StringComparer.Ordinal))
                    {
                        errors.Add(new MetaError(
                            $"relationship \"{obj.Name}.{rel.Name}\" @{RELATIONSHIP_ATTR_SOURCE_REF_FIELD} \"{sourceRefField}\" does not match " +
                            $"any identity.reference FK field on junction \"{through}\". Available: {(fkFields.Count > 0 ? string.Join(", ", fkFields) : "(none)")}.",
                            ErrorCode.ERR_INVALID_RELATIONSHIP,
                            Envelope: rel.Source));
                    }
                }
            }
        }

        return errors.AsReadOnly();
    }

    // =========================================================================
    // Pass 9: ValidateTemplatePayloadRefs
    //   - @payloadRef must resolve to a known object in the model -> ERR_INVALID_TEMPLATE
    //   - every @requiredSlots entry must be a field on that payload -> ERR_INVALID_TEMPLATE
    //
    // Pure metadata cross-references (no provider, no I/O) — the load-time half of
    // the prompt drift guarantee (FR-004). Ported from validateTemplatePayloadRefs
    // in typescript/packages/metadata/src/loader/validation-passes.ts.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateTemplatePayloadRefs(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var tmpl in root.OwnChildren().Where(c => c.Type == TYPE_TEMPLATE))
        {
            // --- @kind / textRef / email part-ref cross-field rules ---
            // template.output is either a document (@kind absent/"document" → @textRef
            // required) or an email (@kind="email" → @subjectRef + @htmlBodyRef required,
            // @textRef unused). template.prompt always requires @textRef (the renderable
            // body). Closed-enum membership of @kind is enforced by the AllowedValues
            // schema pass (ERR_BAD_ATTR_VALUE); here we only enforce conditional ref
            // presence. Mirrors TS validateTemplatePayloadRefs / Java validateTemplateNode.
            if (tmpl.SubType == TEMPLATE_SUBTYPE_OUTPUT)
            {
                if (tmpl.OwnAttr(TEMPLATE_ATTR_KIND) as string == TEMPLATE_KIND_EMAIL)
                {
                    if (tmpl.OwnAttr(TEMPLATE_ATTR_SUBJECT_REF) is not string)
                        errors.Add(new MetaError(
                            $"template \"{tmpl.Name}\" @kind \"email\" requires @subjectRef",
                            ErrorCode.ERR_INVALID_TEMPLATE, Envelope: tmpl.Source));
                    if (tmpl.OwnAttr(TEMPLATE_ATTR_HTML_BODY_REF) is not string)
                        errors.Add(new MetaError(
                            $"template \"{tmpl.Name}\" @kind \"email\" requires @htmlBodyRef",
                            ErrorCode.ERR_INVALID_TEMPLATE, Envelope: tmpl.Source));
                }
                else
                {
                    // @kind absent or "document" → require @textRef so a document is
                    // never bodyless. (An out-of-enum @kind is separately flagged by
                    // the AllowedValues schema pass.)
                    if (tmpl.OwnAttr(TEMPLATE_ATTR_TEXT_REF) is not string)
                        errors.Add(new MetaError(
                            $"template \"{tmpl.Name}\" @kind \"document\" requires @textRef",
                            ErrorCode.ERR_INVALID_TEMPLATE, Envelope: tmpl.Source));
                }
            }
            else if (tmpl.SubType == TEMPLATE_SUBTYPE_PROMPT)
            {
                // template.prompt always carries a renderable body via @textRef.
                if (tmpl.OwnAttr(TEMPLATE_ATTR_TEXT_REF) is not string)
                    errors.Add(new MetaError(
                        $"template \"{tmpl.Name}\" requires @textRef",
                        ErrorCode.ERR_INVALID_TEMPLATE, Envelope: tmpl.Source));
            }

            if (tmpl.OwnAttr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef) continue;

            var payload = root.OwnChildren()
                .FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == payloadRef);
            if (payload is null || payload.SubType != OBJECT_SUBTYPE_VALUE)
            {
                // FR5d — @payloadRef is a reference; emit format=resolved with
                // referrer = template FQN, target = the unresolved payloadRef.
                errors.Add(new MetaError(
                    $"template \"{tmpl.Name}\" @payloadRef \"{payloadRef}\" does not resolve to an object.value at root",
                    ErrorCode.ERR_INVALID_TEMPLATE,
                    Envelope: ResolvedSource.From(tmpl.Source, tmpl.Fqn(), payloadRef)));
                continue;
            }

            // Use Children() (effective) so inherited payload fields are visible.
            var fieldNames = new HashSet<string>(
                payload.Children().Where(c => c.Type == TYPE_FIELD).Select(f => f.Name),
                StringComparer.Ordinal);

            IEnumerable<string> slotList = tmpl.OwnAttr(TEMPLATE_ATTR_REQUIRED_SLOTS) switch
            {
                IReadOnlyList<string> ss => ss,
                IReadOnlyList<object?> os => os.OfType<string>(),
                string s => [s],
                _ => [],
            };
            foreach (var slot in slotList)
            {
                if (!fieldNames.Contains(slot))
                    // FR5d — @requiredSlots is a field-on-payload reference;
                    // emit format=resolved with referrer = template FQN,
                    // target = `payloadRef.slot` (the dotted ref that did not
                    // resolve to a payload field).
                    errors.Add(new MetaError(
                        $"template \"{tmpl.Name}\" @requiredSlots \"{slot}\" is not a field on payload " +
                        $"\"{payloadRef}\". Available fields: {string.Join(", ", fieldNames)}",
                        ErrorCode.ERR_INVALID_TEMPLATE,
                        Envelope: ResolvedSource.From(tmpl.Source, tmpl.Fqn(), $"{payloadRef}.{slot}")));
            }
        }

        return errors.AsReadOnly();
    }
}
