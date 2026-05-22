// ValidationPasses — stateless validation passes for the MetaDataLoader pipeline.
//
// Ported from three TypeScript files:
//   - typescript/packages/metadata/src/subtype-rules.ts
//   - typescript/packages/metadata/src/loader/validation-passes.ts
//   - typescript/packages/metadata/src/attr-schema-validate.ts
//
// Each method takes a fully-merged MetaData root (or registry) and returns
// errors / warnings. No loader state is read or written — pure functions.

using MetaObjects.Meta;

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
        if (model.Type == Constants.TYPE_OBJECT)
        {
            // Use Children() (effective) so inherited identities count.
            bool hasPrimary = model.Children().Any(
                c => c.Type == Constants.TYPE_IDENTITY &&
                     c.SubType == Constants.IDENTITY_SUBTYPE_PRIMARY);

            if (model.SubType == Constants.OBJECT_SUBTYPE_VALUE && hasPrimary)
            {
                errors.Add(new MetaError(
                    $"value object '{model.Fqn()}' must not have a primary identity " +
                    "(use subType: \"entity\" for records with identity)",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION));
            }
            else if (model.SubType == Constants.OBJECT_SUBTYPE_ENTITY &&
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
                     .Where(c => c.Type == Constants.TYPE_OBJECT))
        {
            // Use Children() (effective) so inherited fields are visible when
            // validating @defaultSortField references.
            var effective = obj.Children();
            var fieldNames = new HashSet<string>(
                effective
                    .Where(c => c.Type == Constants.TYPE_FIELD)
                    .Select(f => f.Name),
                StringComparer.Ordinal);

            foreach (var layout in effective.Where(
                c => c.Type == Constants.TYPE_LAYOUT &&
                     c.SubType == Constants.LAYOUT_SUBTYPE_DATA_GRID))
            {
                var sortField = layout.OwnAttr(Constants.LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
                if (sortField is string sf && !fieldNames.Contains(sf))
                {
                    errors.Add(new MetaError(
                        $"dataGrid layout \"{layout.Name}\" on entity \"{obj.Name}\" " +
                        $"has @defaultSortField \"{sf}\" " +
                        $"but no such field exists on \"{obj.Name}\". " +
                        $"Available fields: {string.Join(", ", fieldNames)}",
                        ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD));
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
                     .Where(c => c.Type == Constants.TYPE_OBJECT))
        {
            // Use Children() (effective) so inherited fields and identities are included.
            var effective = obj.Children();

            // Build the set of field names covered by any identity on this object.
            var indexedFieldNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var identity in effective.Where(c => c.Type == Constants.TYPE_IDENTITY))
            {
                var fields = identity.OwnAttr(Constants.IDENTITY_ATTR_FIELDS);
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

            foreach (var field in effective.Where(c => c.Type == Constants.TYPE_FIELD))
            {
                var filterable = field.OwnAttr(Constants.FIELD_ATTR_FILTERABLE);
                if (filterable is not true) continue;
                if (field.OwnAttr(Constants.FIELD_ATTR_DB_INDEXED) is true) continue;
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
                     .Where(c => c.Type == Constants.TYPE_OBJECT))
        {
            foreach (var field in obj.OwnChildren()
                         .Where(c => c.Type == Constants.TYPE_FIELD))
            {
                foreach (var origin in field.OwnChildren()
                             .Where(c => c.Type == Constants.TYPE_ORIGIN))
                {
                    if (origin.SubType == Constants.ORIGIN_SUBTYPE_PASSTHROUGH)
                    {
                        var from = origin.OwnAttr(Constants.ORIGIN_PASSTHROUGH_ATTR_FROM);
                        if (from is not string fromStr || fromStr == "")
                        {
                            errors.Add(new MetaError(
                                $"origin.passthrough on {obj.Name}.{field.Name}: missing @from.",
                                ErrorCode.ERR_INVALID_ORIGIN));
                            continue;
                        }
                        ValidateFromPath(fromStr, root, obj.Name, field.Name, errors,
                            "origin.passthrough.@from");

                        var via = origin.OwnAttr(Constants.ORIGIN_PASSTHROUGH_ATTR_VIA);
                        if (via is string viaStr && viaStr != "")
                        {
                            ValidateViaPath(viaStr, root, obj.Name, field.Name, errors);
                        }
                    }
                    else if (origin.SubType == Constants.ORIGIN_SUBTYPE_AGGREGATE)
                    {
                        var of = origin.OwnAttr(Constants.ORIGIN_AGGREGATE_ATTR_OF);
                        if (of is not string ofStr || ofStr == "")
                        {
                            errors.Add(new MetaError(
                                $"origin.aggregate on {obj.Name}.{field.Name}: missing @of.",
                                ErrorCode.ERR_INVALID_ORIGIN));
                            continue;
                        }
                        ValidateFromPath(ofStr, root, obj.Name, field.Name, errors,
                            "origin.aggregate.@of");

                        var via = origin.OwnAttr(Constants.ORIGIN_AGGREGATE_ATTR_VIA);
                        if (via is not string viaStr || viaStr == "")
                        {
                            errors.Add(new MetaError(
                                $"origin.aggregate on {obj.Name}.{field.Name}: missing @via " +
                                "(aggregates require a relationship path).",
                                ErrorCode.ERR_INVALID_ORIGIN));
                            continue;
                        }
                        ValidateViaPath(viaStr, root, obj.Name, field.Name, errors);
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
            .FirstOrDefault(c => c.Type == Constants.TYPE_OBJECT && c.Name == name);
    }

    // -------------------------------------------------------------------------
    // Origin helper: _findField
    // -------------------------------------------------------------------------

    private static MetaData? FindField(MetaData obj, string name)
    {
        // Use Children() so inherited fields (via extends) are included.
        return obj.Children()
            .FirstOrDefault(c => c.Type == Constants.TYPE_FIELD && c.Name == name);
    }

    // -------------------------------------------------------------------------
    // Origin helper: _findRelationship
    // -------------------------------------------------------------------------

    private static MetaData? FindRelationship(MetaData obj, string name)
    {
        // Use Children() so inherited relationships (via extends) are included.
        return obj.Children()
            .FirstOrDefault(c => c.Type == Constants.TYPE_RELATIONSHIP && c.Name == name);
    }

    // -------------------------------------------------------------------------
    // Origin helper: _validateFromPath
    // -------------------------------------------------------------------------

    private static void ValidateFromPath(
        string fromAttr,
        MetaData root,
        string projectionName,
        string fieldName,
        List<MetaError> errors,
        string label = "origin.passthrough.@from")
    {
        int dotIdx = fromAttr.IndexOf('.', StringComparison.Ordinal);
        if (dotIdx < 1 || dotIdx == fromAttr.Length - 1)
        {
            errors.Add(new MetaError(
                $"{label} \"{fromAttr}\" on {projectionName}.{fieldName}: " +
                "must be of form \"Entity.field\".",
                ErrorCode.ERR_INVALID_ORIGIN));
            return;
        }

        string entityName = fromAttr[..dotIdx];
        string targetFieldName = fromAttr[(dotIdx + 1)..];

        var sourceObj = FindObject(root, entityName);
        if (sourceObj is null)
        {
            errors.Add(new MetaError(
                $"{label} \"{fromAttr}\" on {projectionName}.{fieldName}: " +
                $"no such entity \"{entityName}\".",
                ErrorCode.ERR_INVALID_ORIGIN));
            return;
        }

        var sourceField = FindField(sourceObj, targetFieldName);
        if (sourceField is null)
        {
            errors.Add(new MetaError(
                $"{label} \"{fromAttr}\" on {projectionName}.{fieldName}: " +
                $"no such field \"{targetFieldName}\" on {entityName}.",
                ErrorCode.ERR_INVALID_ORIGIN));
        }
    }

    // -------------------------------------------------------------------------
    // Origin helper: _validateViaPath
    // -------------------------------------------------------------------------

    private static void ValidateViaPath(
        string viaAttr,
        MetaData root,
        string projectionName,
        string fieldName,
        List<MetaError> errors)
    {
        var segments = viaAttr.Split('.');
        if (segments.Length < 2)
        {
            errors.Add(new MetaError(
                $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                "must be of form \"Entity.relationship[.relationship...]\".",
                ErrorCode.ERR_INVALID_ORIGIN));
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
                ErrorCode.ERR_INVALID_ORIGIN));
            return;
        }

        foreach (var relName in relSegments)
        {
            var rel = FindRelationship(currentObj, relName);
            if (rel is null)
            {
                errors.Add(new MetaError(
                    $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                    $"no such relationship \"{relName}\" on {currentObj.Name}.",
                    ErrorCode.ERR_INVALID_ORIGIN));
                return;
            }

            var refTarget = rel.OwnAttr(Constants.RELATIONSHIP_ATTR_OBJECT_REF);
            if (refTarget is not string refStr || refStr == "")
            {
                errors.Add(new MetaError(
                    $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                    $"relationship \"{relName}\" on {currentObj.Name} is missing @objectRef.",
                    ErrorCode.ERR_INVALID_ORIGIN));
                return;
            }

            var nextObj = FindObject(root, refStr);
            if (nextObj is null)
            {
                errors.Add(new MetaError(
                    $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                    $"relationship \"{relName}\" points to non-existent entity \"{refStr}\".",
                    ErrorCode.ERR_INVALID_ORIGIN));
                return;
            }

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
        WalkAttrSchema(root, registry, errors);
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
                     .Where(c => c.Type == Constants.TYPE_OBJECT))
        {
            // Use Children() (effective) so inherited @filterable fields are visible.
            var effective = obj.Children();

            // Build allowlist: field name → allowed ops for its subtype.
            var allow = new Dictionary<string, string[]>(StringComparer.Ordinal);
            foreach (var f in effective.Where(c => c.Type == Constants.TYPE_FIELD))
            {
                if (f.OwnAttr(Constants.FIELD_ATTR_FILTERABLE) is true)
                {
                    allow[f.Name] = Constants.OpsForSubType(f.SubType);
                }
            }

            foreach (var layout in effective.Where(
                c => c.Type == Constants.TYPE_LAYOUT &&
                     c.SubType == Constants.LAYOUT_SUBTYPE_DATA_GRID))
            {
                var filter = layout.OwnAttr(Constants.LAYOUT_DATA_GRID_ATTR_FILTER);
                // Type errors (e.g. legacy string form) are reported by ValidateAttrSchema.
                if (filter is not IReadOnlyDictionary<string, object?> filterObj) continue;
                CheckFilterClauses(filterObj, allow, obj.Name, layout.Name, errors);
            }
        }

        return errors.AsReadOnly();
    }

    private static void CheckFilterClauses(
        IReadOnlyDictionary<string, object?> filter,
        Dictionary<string, string[]> allow,
        string entityName,
        string layoutName,
        List<MetaError> errors)
    {
        foreach (var (key, clause) in filter)
        {
            if (key == Constants.FILTER_COMPOSE_OR || key == Constants.FILTER_COMPOSE_AND)
            {
                if (clause is IReadOnlyList<object?> subList)
                {
                    foreach (var sub in subList)
                    {
                        if (sub is IReadOnlyDictionary<string, object?> subFilter)
                            CheckFilterClauses(subFilter, allow, entityName, layoutName, errors);
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
                    ErrorCode.ERR_BAD_ATTR_FILTER));
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
                            ErrorCode.ERR_BAD_ATTR_FILTER));
                    }
                }
            }
        }
    }

    private static void WalkAttrSchema(
        MetaData node,
        TypeRegistry registry,
        List<MetaError> errors)
    {
        ValidateAttrSchemaNode(node, registry, errors);
        foreach (var child in node.OwnChildren())
        {
            WalkAttrSchema(child, registry, errors);
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
        List<MetaError> errors)
    {
        var schema = registry.AttrsOf(node.Type, node.SubType);
        if (schema.Count == 0) return;

        // Index the schema by attr name for declared-attr checks.
        var byName = new Dictionary<string, AttrSchema>(StringComparer.Ordinal);
        foreach (var spec in schema) byName[spec.Name] = spec;

        // --- Check 1: required attrs present ---
        // Use Attrs() (effective = own + inherited) so a node that legitimately
        // inherits a required attr from its super is not flagged as missing it.
        var effective = node.Attrs();
        foreach (var spec in schema)
        {
            if (spec.Required && !effective.ContainsKey(spec.Name))
            {
                errors.Add(new MetaError(
                    $"{NodeLabel(node)} is missing required attribute '@{spec.Name}'",
                    ErrorCode.ERR_MISSING_REQUIRED_ATTR));
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
                    ErrorCode.ERR_BAD_ATTR_VALUE));
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
                        ErrorCode.ERR_BAD_ATTR_VALUE));
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Attr-type check helper — mirrors valueMatchesType() in attr-schema-validate.ts
    //
    // Numeric attr subtypes (int / long / double) map to either long or double
    // in C# (the parser stores JSON numbers as long when integral, double when
    // fractional). String, class, properties → value is string. Boolean → bool.
    // stringarray → IReadOnlyList<string> (parser desugars bare strings).
    // base or anything unexpected → accept anything.
    // -------------------------------------------------------------------------

    private static bool ValueMatchesType(object? value, string valueType)
    {
        return valueType switch
        {
            Constants.ATTR_SUBTYPE_STRING or
            Constants.ATTR_SUBTYPE_CLASS => value is string,

            Constants.ATTR_SUBTYPE_INT or
            Constants.ATTR_SUBTYPE_LONG => value is long or int,

            Constants.ATTR_SUBTYPE_DOUBLE => value is double or float or long or int,

            Constants.ATTR_SUBTYPE_BOOLEAN => value is bool,

            Constants.ATTR_SUBTYPE_STRINGARRAY =>
                // Must be a real string list; the parser already desugared bare strings.
                value is IReadOnlyList<string> ||
                (value is IReadOnlyList<object?> ol && ol.All(e => e is string)),

            Constants.ATTR_SUBTYPE_PROPERTIES or
            Constants.ATTR_SUBTYPE_FILTER =>
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
}
