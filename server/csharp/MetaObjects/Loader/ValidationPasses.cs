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
        // FR-024 D2 — identity nodes require an author-chosen name (any nesting:
        // object children AND field-nested identities). A nameless node parses
        // with Name == "".
        if (model.Type == TYPE_IDENTITY && model.Name == "")
        {
            var owner = model.Parent?.Fqn();
            errors.Add(new MetaError(
                $"identity.{model.SubType}" +
                (owner is not null && owner != "" ? $" under '{owner}'" : "") +
                " has no name — identity nodes require an author-chosen name (e.g. \"id\") " +
                "so dotted extends refs can address them (FR-024)",
                ErrorCode.ERR_IDENTITY_NAME_REQUIRED,
                Envelope: model.Source));
        }

        if (model.Type == TYPE_OBJECT)
        {
            switch (model.SubType)
            {
                case OBJECT_SUBTYPE_VALUE:
                    ValidateValuePurity(model, errors);
                    break;
                case OBJECT_SUBTYPE_ENTITY:
                    ValidateEntityIdentity(model, warnings);
                    break;
                case OBJECT_SUBTYPE_PROJECTION:
                    ValidateProjectionLicensing(model, errors);
                    break;
                // object.base is a template — no rule.
            }
        }

        // Recurse into own children only (don't double-visit inherited nodes).
        foreach (var child in model.OwnChildren())
        {
            WalkSubtypeRules(child, errors, warnings);
        }
    }

    // FR-024 value purity (ADR-0028): a value object is a pure data shape — it
    // carries NO identity of any subtype and NO source.
    private static void ValidateValuePurity(MetaData model, List<MetaError> errors)
    {
        foreach (var child in model.Children())
        {
            if (child.Type == TYPE_IDENTITY)
            {
                errors.Add(new MetaError(
                    $"value object '{model.Fqn()}' must not have an identity " +
                    $"({TYPE_IDENTITY}.{child.SubType} '{child.Name}') — value objects are " +
                    "pure data shapes; use subType: \"entity\" for records with identity (FR-024, ADR-0028)",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                    Envelope: child.Source));
            }
            else if (child.Type == TYPE_SOURCE)
            {
                errors.Add(new MetaError(
                    $"value object '{model.Fqn()}' must not have a source " +
                    $"({TYPE_SOURCE}.{child.SubType}) — value objects are not persisted " +
                    "shapes; use subType: \"entity\" or \"projection\" for stored objects (FR-024, ADR-0028)",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                    Envelope: child.Source));
            }
        }
    }

    // Entities SHOULD have a primary identity unless abstract (warning).
    private static void ValidateEntityIdentity(MetaData model, List<string> warnings)
    {
        bool hasPrimary = model.Children().Any(
            c => c.Type == TYPE_IDENTITY && c.SubType == IDENTITY_SUBTYPE_PRIMARY);
        if (!hasPrimary && !model.IsAbstract)
        {
            warnings.Add(
                $"entity object '{model.Fqn()}' has no primary identity " +
                "(add an identity child or mark @isAbstract: true)");
        }
    }

    // FR-024 projection licensing (ADR-0028):
    //   - object-level extends may only target another object.projection;
    //   - every OWN source must have a read-only @kind;
    //   - identity is OPTIONAL on a projection (no warning when absent).
    private static void ValidateProjectionLicensing(MetaData model, List<MetaError> errors)
    {
        var sup = model.SuperData;
        if (sup is not null &&
            (sup.Type != TYPE_OBJECT || sup.SubType != OBJECT_SUBTYPE_PROJECTION))
        {
            errors.Add(new MetaError(
                $"projection '{model.Fqn()}' extends '{sup.Fqn()}' which is " +
                $"{sup.Type}.{sup.SubType} — a projection may only extend another projection (FR-024, ADR-0028)",
                ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                Envelope: model.Source));
        }

        // OWN sources only: an inherited source is validated on the object that
        // declares it; an inherited source from a non-projection super is
        // unreachable without first tripping the extends rule above.
        foreach (var child in model.OwnChildren())
        {
            if (child.Type != TYPE_SOURCE) continue;
            string kind = child is MetaSource ms ? ms.EffectiveKind : child.SubType;
            if (!SOURCE_READ_ONLY_KINDS.Contains(kind))
            {
                errors.Add(new MetaError(
                    $"projection '{model.Fqn()}' has a writable source (@kind \"{kind}\") — " +
                    "a projection is a derived read-only representation; its sources must be " +
                    "read-only kinds (view, materializedView, storedProc, tableFunction) (FR-024, ADR-0028)",
                    ErrorCode.ERR_PROJECTION_SOURCE_WRITABLE,
                    Envelope: child.Source));
            }
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
    // Pass 4b: ValidateFilterableHasSupportedOps (SP-H Unit9)
    //   - @filterable: true on a field subtype with NO entry in OPS_BY_SUBTYPE
    //     (e.g. field.object) → error ERR_FILTERABLE_UNSUPPORTED_SUBTYPE.
    //     Such a field would silently generate an empty-ops filter — a route
    //     that rejects every request.
    //
    // Ported from typescript/packages/metadata/src/loader/validation-passes.ts
    // validateFilterableHasSupportedOps.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateFilterableHasSupportedOps(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var obj in root.OwnChildren()
                     .Where(c => c.Type == TYPE_OBJECT))
        {
            // Children() (effective) — inherited @filterable fields are visible.
            foreach (var field in obj.Children().Where(c => c.Type == TYPE_FIELD))
            {
                if (field.OwnAttr(FIELD_ATTR_FILTERABLE) is not true) continue;
                if (OpsForSubType(field.SubType).Length > 0) continue;
                errors.Add(new MetaError(
                    $"Field \"{obj.Name}.{field.Name}\" has @filterable: true but its subtype " +
                    $"\"{field.SubType}\" has no filter-operator band. Remove @filterable, or use a " +
                    "field subtype that supports filtering (string/enum/uuid/number/currency/date/boolean).",
                    ErrorCode.ERR_FILTERABLE_UNSUPPORTED_SUBTYPE,
                    Envelope: field.Source));
            }
        }

        return errors.AsReadOnly();
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
            // FR-024 B5: object.value hosts are EXEMPT from @via inference and
            // cardinality checks — a value's origin.passthrough is FR-015 parameter
            // lineage (values are constructed, never assembled; spec §7), not an
            // assembly path. Their @from refs are still resolution-validated.
            bool isValueHost = obj.SubType == OBJECT_SUBTYPE_VALUE;

            foreach (var field in obj.OwnChildren()
                         .Where(c => c.Type == TYPE_FIELD))
            {
                foreach (var origin in field.OwnChildren()
                             .Where(c => c.Type == TYPE_ORIGIN))
                {
                    if (origin.SubType == ORIGIN_SUBTYPE_PASSTHROUGH)
                    {
                        var fromObj = origin.OwnAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
                        if (fromObj is not string from || from == "")
                        {
                            // Missing-attr (not a reference resolution failure) —
                            // keep the node's own source envelope (json/yaml/merged).
                            errors.Add(new MetaError(
                                $"origin.passthrough on {obj.Name}.{field.Name}: missing @from.",
                                ErrorCode.ERR_INVALID_ORIGIN,
                                Envelope: origin.Source));
                            continue;
                        }
                        var fromTarget = ValidateFromPath(from, root, obj, field.Name, errors,
                            "origin.passthrough.@from", origin.Source);
                        // FR-024 B6 — extends/origin agreement (host-agnostic; runs
                        // whether @via is explicit, inferred, or a base-relation column).
                        if (fromTarget is ResolvedFromTarget ft1)
                        {
                            CheckExtendsOriginAgreement(field, ft1.Field, from, obj, origin.Source, errors);
                        }
                        var viaObj = origin.OwnAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
                        if (viaObj is string via && via != "")
                        {
                            var hops = ValidateViaPath(via, root, obj, field.Name, errors, origin.Source);
                            if (hops is not null)
                                CheckPassthroughCardinality(hops, obj, field.Name, origin.Source, errors);
                        }
                        else if (fromTarget is ResolvedFromTarget ft2 && !isValueHost)
                        {
                            // FR-024 §6 — no @via: derive the base entity; a @from
                            // targeting the base relation itself is a plain base column
                            // (no checks); otherwise infer the single-hop-unique path
                            // and gate cardinality.
                            var baseEntity = DeriveBaseEntity(obj, root, field.Name, origin.Source, errors);
                            if (baseEntity is not null && !IsBaseRelationTarget(ft2.Entity, baseEntity, obj))
                            {
                                var hops = InferViaSingleHop(baseEntity, ft2.Entity, obj, field.Name, from,
                                    "origin.passthrough.@from", origin.Source, errors);
                                if (hops is not null)
                                    CheckPassthroughCardinality(hops, obj, field.Name, origin.Source, errors);
                            }
                        }
                    }
                    else if (origin.SubType == ORIGIN_SUBTYPE_AGGREGATE)
                    {
                        var ofObj = origin.OwnAttr(ORIGIN_AGGREGATE_ATTR_OF);
                        if (ofObj is not string of || of == "")
                        {
                            // Missing-attr — keep origin's own source envelope.
                            errors.Add(new MetaError(
                                $"origin.aggregate on {obj.Name}.{field.Name}: missing @of.",
                                ErrorCode.ERR_INVALID_ORIGIN,
                                Envelope: origin.Source));
                            continue;
                        }
                        // NOTE (FR-024 B6): NO extends/origin agreement on aggregates.
                        var ofTarget = ValidateFromPath(of, root, obj, field.Name, errors,
                            "origin.aggregate.@of", origin.Source);
                        var viaObj = origin.OwnAttr(ORIGIN_AGGREGATE_ATTR_VIA);
                        if (viaObj is string via && via != "")
                        {
                            var hops = ValidateViaPath(via, root, obj, field.Name, errors, origin.Source);
                            if (hops is not null)
                                CheckAggregateCardinality(hops, obj, field.Name, origin.Source, errors);
                            continue;
                        }
                        // FR-024 §6 — no @via on an aggregate: inference applies only
                        // when @of targets a non-base entity from a non-value host.
                        if (ofTarget is not ResolvedFromTarget oft) continue; // @of did not resolve
                        if (isValueHost)
                        {
                            errors.Add(new MetaError(
                                $"origin.aggregate on {obj.Name}.{field.Name}: missing @via " +
                                "(aggregates require a relationship path).",
                                ErrorCode.ERR_INVALID_ORIGIN,
                                Envelope: origin.Source));
                            continue;
                        }
                        var aggBase = DeriveBaseEntity(obj, root, field.Name, origin.Source, errors);
                        if (aggBase is null) continue; // base underivable — error already pushed
                        if (IsBaseRelationTarget(oft.Entity, aggBase, obj))
                        {
                            errors.Add(new MetaError(
                                $"origin.aggregate on {obj.Name}.{field.Name}: missing @via " +
                                "(aggregates require a relationship path).",
                                ErrorCode.ERR_INVALID_ORIGIN,
                                Envelope: origin.Source));
                            continue;
                        }
                        var aggHops = InferViaSingleHop(aggBase, oft.Entity, obj, field.Name, of,
                            "origin.aggregate.@of", origin.Source, errors);
                        if (aggHops is not null)
                            CheckAggregateCardinality(aggHops, obj, field.Name, origin.Source, errors);
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
        // FR-032 (ADR-0032): origin ref heads (@from/@of/@via) and relationship
        // @objectRef values are FULLY QUALIFIED after the desugar/corpus sweep
        // (e.g. "acme::commerce::Program"). Match FQN-tolerantly — the canonical
        // ResolutionKey()/Fqn() OR the bare Name. Mirrors TS refMatchesObject.
        return root.OwnChildren()
            .FirstOrDefault(c => c.Type == TYPE_OBJECT && RefMatchesObject(c, name));
    }

    // FR-032 (ADR-0032) — does object `node` satisfy an (already-expanded) FQN ref?
    // After the YAML desugar + corpus sweep every ref is fully qualified, so this
    // is a pure FQN match against the canonical ResolutionKey(); the Fqn()/Name
    // arms cover legacy same-tree refs and root-level (empty-package) objects.
    // Mirrors TS refMatchesObject / Java ValidationPhase.nameMatches.
    internal static bool RefMatchesObject(MetaData node, string reference)
        => node.ResolutionKey() == reference
        || node.Fqn() == reference
        || node.Name == reference;

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

    /// Resolved `Entity.field` reference target: the entity AND the field node.
    /// FR-024 B5 inference needs the entity; the B6 agreement check compares
    /// against the field node identity.
    private readonly record struct ResolvedFromTarget(MetaData Entity, MetaData Field);

    /// Validate a passthrough `@from` / aggregate `@of` "Entity.field" reference.
    /// Returns the resolved (entity, field) on full success, or null when any
    /// error was pushed (malformed shape / unknown entity / unknown field).
    private static ResolvedFromTarget? ValidateFromPath(
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
            return null;
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
            return null;
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
            return null;
        }

        return new ResolvedFromTarget(sourceObj, sourceField);
    }

    // -------------------------------------------------------------------------
    // Origin helper: _validateViaPath
    // -------------------------------------------------------------------------

    /// Validate an explicit `@via` "Entity.rel[.rel...]" path. Returns the walked
    /// relationship hop nodes (in path order) on full success — FR-024 B5 runs
    /// the cardinality checks over them — or null when any error was pushed.
    private static List<MetaData>? ValidateViaPath(
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
            return null;
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
            return null;
        }

        // FR5d — track the deepest-valid-prefix as we walk. The prefix grows
        // segment-by-segment; on a hop failure the error message names the
        // prefix that DID resolve, so authors can fix multi-hop typos quickly.
        // After the entity lookup above, the deepest valid prefix is just the
        // entity name; each successful relationship hop appends a segment.
        var validSegments = new List<string> { entityName };
        var hops = new List<MetaData>();

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
                return null;
            }

            var refTarget = rel.OwnAttr(RELATIONSHIP_ATTR_OBJECT_REF);
            if (refTarget is not string refStr || refStr == "")
            {
                errors.Add(new MetaError(
                    $"origin.@via \"{viaAttr}\" on {projectionName}.{fieldName}: " +
                    $"relationship \"{relName}\" on {currentObj.Name} is missing @objectRef.",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    Envelope: ResolvedSource.From(originSource, referrer, viaAttr)));
                return null;
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
                return null;
            }

            validSegments.Add(relName);
            hops.Add(rel);
            currentObj = nextObj;
        }

        return hops;
    }

    // -------------------------------------------------------------------------
    // FR-024 B5 — base-entity derivation, single-hop-unique @via inference, and
    // origin cardinality checks (spec §5–§6; ADR-0029 decisions 5–6).
    // -------------------------------------------------------------------------

    /// A hop relationship's effective @cardinality, or null when not declared.
    private static string? HopCardinality(MetaData rel)
        => rel.Attr(RELATIONSHIP_ATTR_CARDINALITY) as string;

    /// FR-024: the entity NAMED by a node's dotted extends ref — the OWNER part
    /// of `<owner>.<child>...` resolved as an object. Differs from
    /// SuperData.Parent when the resolved child is INHERITED.
    private static MetaData? RefNamedOwner(MetaData node, MetaData root)
    {
        var reference = node.SuperRef;
        if (reference is null) return null;
        int lastSep = reference.LastIndexOf("::", StringComparison.Ordinal);
        string tail = lastSep == -1 ? reference : reference[(lastSep + 2)..];
        int dot = tail.IndexOf('.', StringComparison.Ordinal);
        if (dot <= 0) return null;
        return FindObject(root, tail[..dot]);
    }

    /// Derive the BASE entity a no-`@via` origin path anchors at (spec §5).
    /// Returns null when no base is derivable (an error has been pushed).
    private static MetaData? DeriveBaseEntity(
        MetaData obj, MetaData root, string fieldName, ErrorSource originSource, List<MetaError> errors)
    {
        if (obj.SubType != OBJECT_SUBTYPE_PROJECTION) return obj;

        // 1) The extended identity anchors the base entity (declared, not inferred).
        foreach (var identity in obj.OwnChildren().Where(c => c.Type == TYPE_IDENTITY))
        {
            var extended = identity.SuperData;
            if (extended is not null && extended.Type == TYPE_IDENTITY)
            {
                var named = RefNamedOwner(identity, root);
                if (named is not null) return named;
                var owner = extended.Parent;
                if (owner is not null && owner.Type == TYPE_OBJECT) return owner;
            }
        }

        // 2) Fallback: the single distinct entity targeted by plain field-extends —
        //    preferring the ref-named owner over the physical declaring ancestor.
        var targets = new HashSet<MetaData>();
        foreach (var f in obj.OwnChildren().Where(c => c.Type == TYPE_FIELD))
        {
            var sup = f.SuperData;
            if (sup is null) continue;
            var named = RefNamedOwner(f, root);
            var owner = named ?? sup.Parent;
            if (owner is not null && owner.Type == TYPE_OBJECT &&
                owner.SubType != OBJECT_SUBTYPE_VALUE && !ReferenceEquals(owner, obj))
            {
                targets.Add(owner);
            }
        }
        if (targets.Count == 1) return targets.First();
        if (targets.Count > 1)
        {
            string names = string.Join(", ", targets.Select(t => $"\"{t.Name}\""));
            errors.Add(new MetaError(
                $"origin on {obj.Name}.{fieldName}: cannot derive the base entity — the projection's fields extend " +
                $"multiple entities ({names}) and no identity extends an entity identity. Declare an extended identity " +
                "(e.g. identity.primary { name: \"id\", extends: \"<Entity>.<identity>\" }) to anchor the base entity (FR-024).",
                ErrorCode.ERR_AMBIGUOUS_PATH,
                Envelope: originSource));
        }
        else
        {
            errors.Add(new MetaError(
                $"origin on {obj.Name}.{fieldName}: cannot derive the base entity for @via inference — the projection " +
                "has no extended identity and no entity-targeted field extends. Declare an extended identity or an explicit @via (FR-024).",
                ErrorCode.ERR_INVALID_ORIGIN,
                Envelope: originSource));
        }
        return null;
    }

    /// True when the @from/@of target IS the host's base relation: the derived
    /// base entity itself, or an ancestor on the base's (or host's) extends chain.
    private static bool IsBaseRelationTarget(MetaData target, MetaData baseEntity, MetaData host)
    {
        for (MetaData? cur = baseEntity; cur is not null; cur = cur.SuperData)
            if (ReferenceEquals(cur, target)) return true;
        for (MetaData? cur = host; cur is not null; cur = cur.SuperData)
            if (ReferenceEquals(cur, target)) return true;
        return false;
    }

    /// Single-hop-unique `@via` inference (ADR-0029 decision 5). Exactly one
    /// matching relationship → the inferred path; zero → ERR_INVALID_ORIGIN;
    /// more than one → ERR_AMBIGUOUS_PATH.
    private static List<MetaData>? InferViaSingleHop(
        MetaData baseEntity, MetaData targetEntity, MetaData obj, string fieldName,
        string fromAttr, string label, ErrorSource originSource, List<MetaError> errors)
    {
        var candidates = baseEntity.Children()
            .Where(c => c.Type == TYPE_RELATIONSHIP)
            .Where(rel =>
            {
                var r = rel.OwnAttr(RELATIONSHIP_ATTR_OBJECT_REF);
                return r is string rs && StripPackageName(rs) == targetEntity.Name;
            })
            .ToList();
        string referrer = $"{obj.Fqn()}::{fieldName}";
        if (candidates.Count == 1) return new List<MetaData> { candidates[0] };
        if (candidates.Count == 0)
        {
            errors.Add(new MetaError(
                $"{label} \"{fromAttr}\" on {obj.Name}.{fieldName}: no @via and no single-hop relationship from base " +
                $"entity \"{baseEntity.Name}\" to \"{targetEntity.Name}\" — cannot infer the path. Declare @via explicitly " +
                "(multi-hop paths are always explicit; ADR-0029).",
                ErrorCode.ERR_INVALID_ORIGIN,
                Envelope: ResolvedSource.From(originSource, referrer, fromAttr)));
            return null;
        }
        string names = string.Join(", ", candidates.Select(r => $"\"{r.Name}\""));
        errors.Add(new MetaError(
            $"{label} \"{fromAttr}\" on {obj.Name}.{fieldName}: no @via and {candidates.Count} relationships from " +
            $"base entity \"{baseEntity.Name}\" to \"{targetEntity.Name}\" ({names}) — ambiguous. Declare @via naming one of them (ADR-0029).",
            ErrorCode.ERR_AMBIGUOUS_PATH,
            Envelope: ResolvedSource.From(originSource, referrer, fromAttr)));
        return null;
    }

    private static string StripPackageName(string name)
    {
        int idx = name.LastIndexOf("::", StringComparison.Ordinal);
        return idx >= 0 ? name[(idx + 2)..] : name;
    }

    /// ADR-0029 decision 6 — a passthrough via-path must be effectively to-one at
    /// EVERY hop. A hop is to-many only when it DECLARES @cardinality "many".
    private static void CheckPassthroughCardinality(
        IReadOnlyList<MetaData> hops, MetaData obj, string fieldName, ErrorSource originSource, List<MetaError> errors)
    {
        foreach (var rel in hops)
        {
            if (HopCardinality(rel) == CARDINALITY_MANY)
            {
                errors.Add(new MetaError(
                    $"origin.passthrough on {obj.Name}.{fieldName}: @via hop \"{rel.Name}\" is to-many " +
                    $"(@cardinality \"{CARDINALITY_MANY}\") — a row-multiplying passthrough — you meant aggregate (ADR-0029).",
                    ErrorCode.ERR_ORIGIN_CARDINALITY,
                    Envelope: originSource));
                return;
            }
        }
    }

    /// ADR-0029 decision 6 — an aggregate via-path must contain at least one
    /// to-many hop. The error fires only when the path is PROVABLY to-one
    /// (every hop declares @cardinality "one").
    private static void CheckAggregateCardinality(
        IReadOnlyList<MetaData> hops, MetaData obj, string fieldName, ErrorSource originSource, List<MetaError> errors)
    {
        if (hops.Count == 0) return;
        bool provablyToOne = hops.All(rel => HopCardinality(rel) == CARDINALITY_ONE);
        if (provablyToOne)
        {
            errors.Add(new MetaError(
                $"origin.aggregate on {obj.Name}.{fieldName}: every @via hop is to-one (@cardinality \"{CARDINALITY_ONE}\") — " +
                "aggregating over a to-one path — you meant passthrough (ADR-0029).",
                ErrorCode.ERR_ORIGIN_CARDINALITY,
                Envelope: originSource));
        }
    }

    /// FR-024 B6 (spec §4; ADR-0029 decision 7) — extends/origin agreement.
    /// When a field declares BOTH an entity-nested extends and an
    /// origin.passthrough @from, the resolved @from target must be the same node
    /// as the field's resolved extends target (or on its extends chain).
    private static void CheckExtendsOriginAgreement(
        MetaData field, MetaData fromField, string fromAttr, MetaData obj, ErrorSource originSource, List<MetaError> errors)
    {
        var sup = field.SuperData;
        if (sup is null || sup.Type != TYPE_FIELD) return;
        var supOwner = sup.Parent;
        if (supOwner is null || supOwner.Type != TYPE_OBJECT) return;
        for (MetaData? cur = sup; cur is not null; cur = cur.SuperData)
            if (ReferenceEquals(cur, fromField)) return; // shape + data lineage agree
        errors.Add(new MetaError(
            $"origin.passthrough on {obj.Name}.{field.Name}: @from \"{fromAttr}\" disagrees with the field's extends " +
            $"target \"{supOwner.Name}.{sup.Name}\" — extends (shape lineage) and origin.passthrough (data lineage) " +
            "must point at the same entity field (FR-024).",
            ErrorCode.ERR_EXTENDS_ORIGIN_MISMATCH,
            Envelope: ResolvedSource.From(originSource, $"{obj.Fqn()}::{field.Name}", fromAttr)));
    }

    // =========================================================================
    // FR-024 B3 — projection identity pass-through + key correspondence.
    //   ERR_PROJECTION_IDENTITY_NOT_EXTENDED / ERR_IDENTITY_KEY_MISMATCH.
    //   Ported from core/identity/validate-identity-passthrough.ts
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateIdentityPassthrough(MetaData root)
    {
        var errors = new List<MetaError>();
        foreach (var obj in root.OwnChildren()
                     .Where(c => c.Type == TYPE_OBJECT && c.SubType == OBJECT_SUBTYPE_PROJECTION))
        {
            foreach (var identity in obj.OwnChildren().Where(c => c.Type == TYPE_IDENTITY))
            {
                if (identity.SuperRef is null)
                {
                    errors.Add(new MetaError(
                        $"identity '{identity.Name}' on projection '{obj.Name}' must extend an entity identity " +
                        "(e.g. extends: \"Customer.id\") — a projection identity is a pass-through (FR-024)",
                        ErrorCode.ERR_PROJECTION_IDENTITY_NOT_EXTENDED,
                        Envelope: identity.Source));
                    continue;
                }

                var res = ResolveIdentityPassthrough(identity);
                // Unresolved / non-identity target: ERR_UNRESOLVED_SUPER /
                // ERR_EXTENDS_TARGET_MISMATCH already reported by super resolution.
                if (res is null) continue;
                var (entity, computedFields, missing) = res.Value;

                if (missing.Count > 0)
                {
                    string missingRefs = string.Join(", ", missing.Select(f => $"'{entity.Name}.{f}'"));
                    errors.Add(new MetaError(
                        $"identity '{identity.Name}' on projection '{obj.Name}' does not correspond to its " +
                        $"extended identity: no local field extends {missingRefs} — every field of the " +
                        "extended identity needs a pass-through field on the projection (FR-024)",
                        ErrorCode.ERR_IDENTITY_KEY_MISMATCH,
                        Envelope: identity.Source));
                    continue;
                }

                var explicitFields = IdentityOwnFields(identity);
                if (explicitFields is not null && !explicitFields.SequenceEqual(computedFields))
                {
                    errors.Add(new MetaError(
                        $"identity '{identity.Name}' on projection '{obj.Name}' declares @fields " +
                        $"[{string.Join(", ", explicitFields)}] but the computed pass-through key is " +
                        $"[{string.Join(", ", computedFields)}] — omit @fields (it is derived) or make them agree (FR-024)",
                        ErrorCode.ERR_IDENTITY_KEY_MISMATCH,
                        Envelope: identity.Source));
                }
            }
        }
        return errors.AsReadOnly();
    }

    private static List<string>? NormalizeIdentityFields(object? raw)
    {
        if (raw is null) return null;
        if (raw is string s)
            return s.Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        if (raw is System.Collections.IEnumerable en)
            return en.Cast<object?>().Select(v => (v?.ToString() ?? "").Trim()).ToList();
        return null;
    }

    private static List<string>? IdentityOwnFields(MetaData identity)
        => NormalizeIdentityFields(identity.OwnAttr(IDENTITY_ATTR_FIELDS));

    private static List<string>? IdentityEffectiveFields(MetaData identity)
        => NormalizeIdentityFields(identity.Attr(IDENTITY_ATTR_FIELDS));

    private static (MetaData Entity, List<string> ComputedFields, List<string> Missing)?
        ResolveIdentityPassthrough(MetaData identity)
    {
        var extended = identity.SuperData;
        if (extended is null || extended.Type != TYPE_IDENTITY) return null;
        var entity = extended.Parent;
        if (entity is null || entity.Type != TYPE_OBJECT) return null;
        var owner = identity.Parent;
        if (owner is null) return null;

        var extendedFields = IdentityEffectiveFields(extended) ?? new List<string>();
        var computedFields = new List<string>();
        var missing = new List<string>();
        foreach (var fieldName in extendedFields)
        {
            var entityField = entity.Children()
                .FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == fieldName);
            if (entityField is null) { missing.Add(fieldName); continue; }
            var local = owner.OwnChildren()
                .FirstOrDefault(c => c.Type == TYPE_FIELD && ExtendsChainReaches(c, entityField));
            if (local is null) { missing.Add(fieldName); continue; }
            computedFields.Add(local.Name);
        }
        return (entity, computedFields, missing);
    }

    private static bool ExtendsChainReaches(MetaData node, MetaData target)
    {
        var cur = node.SuperData;
        while (cur is not null)
        {
            if (ReferenceEquals(cur, target)) return true;
            cur = cur.SuperData;
        }
        return false;
    }

    // =========================================================================
    // FR-024 B6 — derived-field providability (spec §7 population doctrine).
    //   An object.entity field carrying any origin.* is derived (read-only): it
    //   does not exist on the writable table — a read-capable (read-only-kind)
    //   source must provide it on read. → ERR_DERIVED_FIELD_NO_READ_SOURCE.
    //   Ported from loader/validation-passes.ts validateDerivedFieldProvidability.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateDerivedFieldProvidability(MetaData root)
    {
        var errors = new List<MetaError>();
        foreach (var obj in root.OwnChildren()
                     .Where(c => c.Type == TYPE_OBJECT && c.SubType == OBJECT_SUBTYPE_ENTITY))
        {
            bool hasReadCapableSource = obj.Children()
                .Where(c => c.Type == TYPE_SOURCE)
                .OfType<MetaSource>()
                .Any(s => s.IsReadOnly());
            if (hasReadCapableSource) continue;
            foreach (var field in obj.OwnChildren().Where(c => c.Type == TYPE_FIELD))
            {
                if (!field.OwnChildren().Any(c => c.Type == TYPE_ORIGIN)) continue;
                errors.Add(new MetaError(
                    $"derived field \"{obj.Name}.{field.Name}\" carries an origin.* but entity \"{obj.Name}\" declares no " +
                    "read-capable source — derived fields do not exist on the writable table. Declare a read-only source " +
                    "(e.g. source.rdb @kind \"view\" @role \"replica\") to provide it, or move the field to an object.projection (FR-024 §7).",
                    ErrorCode.ERR_DERIVED_FIELD_NO_READ_SOURCE,
                    Envelope: field.Source));
            }
        }
        return errors.AsReadOnly();
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
        TypeRegistry registry,
        // ADR-0023 — strict load closes the open-attr policy: an own @-attr matching
        // no per-type schema and no commonAttr -> ERR_UNKNOWN_ATTR (Check 0). Defaults
        // false so lax callers keep the legacy open policy; the library loader (and
        // the conformance runner) load strict.
        bool strict = false)
    {
        var errors = new List<MetaError>();
        var reportedConflicts = new HashSet<string>(StringComparer.Ordinal);
        WalkAttrSchema(root, registry, errors, reportedConflicts, strict);
        return new AttrSchemaValidationResult(errors.AsReadOnly(), []);
    }

    // =========================================================================
    // Pass 6b: ValidateMaxOccurs
    //   Generic singleton-cardinality enforcement. Per parent, tallies own children
    //   by (type, subType); the moment a group exceeds its registered MaxOccurs the
    //   OFFENDING child is reported with ERR_TOO_MANY_OCCURRENCES (envelope = that
    //   child's source, so the cross-port jsonPath points at it).
    //
    //   MaxOccurs == 0 means unbounded (the default) — skipped. This is the generic
    //   enforcement backing the config-driven default-name rule: identity.primary
    //   (MaxOccurs == 1, DefaultName == "primary") is the first consumer.
    // =========================================================================

    public static IReadOnlyList<MetaError> ValidateMaxOccurs(MetaData root, TypeRegistry registry)
    {
        var errors = new List<MetaError>();
        WalkMaxOccurs(root, registry, errors);
        return errors;
    }

    private static void WalkMaxOccurs(MetaData node, TypeRegistry registry, List<MetaError> errors)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var child in node.OwnChildren())
        {
            TypeDefinition? def = registry.Find(child.Type, child.SubType);
            if (def is null || def.MaxOccurs < 1) continue; // 0 = unbounded
            string key = $"{child.Type}.{child.SubType}";
            counts.TryGetValue(key, out int seen);
            seen++;
            counts[key] = seen;
            if (seen > def.MaxOccurs)
            {
                string head = node.Name != "" ? $"'{node.Name}' " : "";
                errors.Add(new MetaError(
                    $"{head}declares more than {def.MaxOccurs} {key} " +
                    $"child{(def.MaxOccurs == 1 ? "" : "ren")}; at most {def.MaxOccurs} is allowed",
                    ErrorCode.ERR_TOO_MANY_OCCURRENCES,
                    Envelope: child.Source));
            }
        }
        foreach (var child in node.OwnChildren())
        {
            WalkMaxOccurs(child, registry, errors);
        }
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
        HashSet<string> reportedConflicts,
        bool strict)
    {
        ValidateAttrSchemaNode(node, registry, errors, reportedConflicts, strict);
        foreach (var child in node.OwnChildren())
        {
            WalkAttrSchema(child, registry, errors, reportedConflicts, strict);
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
        HashSet<string> reportedConflicts,
        bool strict)
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

        // --- Check 0 (ADR-0023): strict-load undeclared-attr rejection ---
        //
        // Runs BEFORE the byName.Count early-return: a node type with no per-type
        // schema and no common attrs (byName empty) must still reject an authored
        // @-attr under strict. Own-attrs only — an inherited/overlaid declared attr
        // was validated on its declaring node and never appears in OwnAttrs().
        // An own attr matching neither a per-type schema entry nor a commonAttr is
        // a made-up attribute -> ERR_UNKNOWN_ATTR (closing the open policy). In lax
        // mode this stays a no-op (legacy open-attr behavior).
        if (strict)
        {
            // attr.properties is a first-class, registered, canonical attr subtype
            // whose designed purpose is an arbitrary-named structural property bag
            // (its NAME is intentionally not declared by any per-type schema). It is
            // sanctioned vocabulary, not a made-up attribute, so strict-attr exempts a
            // materialized properties-attr from ERR_UNKNOWN_ATTR. (A typo'd plain @-attr
            // still fails — only the `properties` subtype is exempt.) An own attr is
            // dual-stored (a structural MetaAttr child + a SetAttr map entry), so the
            // child's subType is the SSOT for the exemption. Mirrors the TS reference
            // (attr-schema-validate.ts: `if (inst.subType === ATTR_SUBTYPE_PROPERTIES)`).
            var propertyBagNames = node
                .OwnChildrenOfSubType(TYPE_ATTR, ATTR_SUBTYPE_PROPERTIES)
                .Select(c => c.Name)
                .ToHashSet(StringComparer.Ordinal);

            foreach (var (attrName, _) in node.OwnAttrs())
            {
                // The reserved structural key `value` is dual-stored on an attr
                // node's _attrs map (parseAttrChild: SetAttr(RESERVED_KEY_VALUE, …)).
                // It is the node's intrinsic value, never an authored @-attr, so it
                // must not be mistaken for a made-up attribute. (In the TS reference
                // an attr node's `value` is not a MetaAttr instance, so it never
                // appears in ownMetaAttrs() — skipping it here gives identical walk
                // behavior on this C#-port dual-storage representation.)
                if (attrName == RESERVED_KEY_VALUE) continue;
                if (propertyBagNames.Contains(attrName)) continue;
                if (!byName.ContainsKey(attrName))
                {
                    errors.Add(new MetaError(
                        $"Unknown attribute '@{attrName}' on {NodeLabel(node)} — " +
                        $"not declared by any registered provider for {typeKey}",
                        ErrorCode.ERR_UNKNOWN_ATTR,
                        Envelope: node.Source));
                }
            }
        }

        // --- Check 0b (FR-033): strict-load structural-child placement ---
        //
        // The structural analogue of Check 0. A STRUCTURAL child (field / identity /
        // source / validator / … — NOT an attr; attrs go through Check 0's
        // ERR_UNKNOWN_ATTR path) must be admitted by the parent's registered
        // childRules under the same wildcard match semantics used everywhere
        // (ChildRuleHelper.ChildRuleMatches — childType / childSubType / childName
        // may be "*"). A child the rules do not admit -> ERR_CHILD_NOT_ALLOWED (the
        // structural analogue of Check 0's ERR_UNKNOWN_ATTR). Strict-load only; lax
        // keeps the legacy open policy. An UNREGISTERED parent cannot be judged here
        // (ERR_UNKNOWN_TYPE / ERR_UNKNOWN_SUBTYPE is reported elsewhere) -> skip so we
        // never double-report. Note: on this C# port attrs are dual-stored as
        // attr.* MetaData children, so OwnChildren() includes them — they are
        // filtered out (Type == TYPE_ATTR) so they stay on the ERR_UNKNOWN_ATTR path.
        // Mirrors the TS reference Check 0b in attr-schema-validate.ts + Python's
        // Check 0b in validation_passes.py.
        if (strict)
        {
            var parentDef = registry.Find(node.Type, node.SubType);
            if (parentDef is not null)
            {
                var rules = parentDef.ChildRules;
                foreach (var child in node.OwnChildren())
                {
                    if (child.Type == TYPE_ATTR) continue; // attrs -> Check 0
                    bool admitted = rules.Any(r =>
                        ChildRuleHelper.ChildRuleMatches(r, child.Type, child.SubType, child.Name));
                    if (!admitted)
                    {
                        errors.Add(new MetaError(
                            $"Child {NodeLabel(child)} is not allowed under {NodeLabel(node)} — " +
                            $"no registered child rule for {typeKey} admits " +
                            $"(type='{child.Type}', subType='{child.SubType}', name='{child.Name}')",
                            ErrorCode.ERR_CHILD_NOT_ALLOWED,
                            Envelope: node.Source));
                    }
                }
            }
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
            // An array-valued attr (the `string` + IsArray model that replaced the
            // `stringarray` subtype) is validated as a string array.
            string? effectiveValueType = spec.ValueType is not null
                && (spec.IsArray || spec.ValueType == ATTR_SUBTYPE_STRINGARRAY)
                ? ATTR_SUBTYPE_STRINGARRAY
                : spec.ValueType;
            if (effectiveValueType is not null && !ValueMatchesType(value, effectiveValueType))
            {
                errors.Add(new MetaError(
                    $"{NodeLabel(node)} attribute '@{attrName}' must be of type " +
                    $"'{effectiveValueType}' but got {RuntimeTypeName(value)}",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    Envelope: node.Source));
                // Skip allowedValues check when type is already wrong.
                continue;
            }

            // Check 3: allowedValues membership.
            //
            // @dbColumnType is exempt here: it carries `allowedValues` ONLY so the
            // value-set surfaces in the registry manifest (ADR-0036 Wave 1), but its
            // real constraint — both an unrecognized value AND the (subtype × value)
            // pairing — is enforced by ValidateDbColumnType, which emits the single
            // ERR_BAD_ATTR_VALUE. Running the flat membership check too would
            // double-report. Mirrors the TS Check-3 exemption.
            if (attrName != FIELD_ATTR_DB_COLUMN_TYPE
                && spec.AllowedValues is { Count: > 0 } allowed)
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

        // FR-024 (ADR-0028) — THE HARD CUTOVER (B4b): an entity's PRIMARY source
        // must be a writable kind; read-only kinds (view/materializedView/storedProc/
        // tableFunction) are legal only in non-primary (read) roles. The pre-FR-024
        // spellings (view-primary "projection" entities, proc-result-as-entity) are
        // removed outright — a derived read model is an object.projection.
        if (obj.IsEntity())
        {
            foreach (var s in sources)
            {
                if (s.Role == SOURCE_ROLE_PRIMARY && s.IsReadOnly())
                {
                    errors.Add(new MetaError(
                        $"entity \"{obj.Name}\" has a primary source of read-only kind \"{s.EffectiveKind}\" — " +
                        "read-only kinds are legal only in non-primary roles; a derived read model " +
                        "is an object.projection (FR-024, ADR-0028)",
                        ErrorCode.ERR_ENTITY_PRIMARY_SOURCE_READONLY,
                        Envelope: s.Source));
                }
            }
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
    //     1. The value must be one of the closed set uuid|jsonb (ADR-0036 Wave 2:
    //        timestamp_with_tz retired) → ERR_BAD_ATTR_VALUE otherwise.
    //     2. The (logical subtype × value) pairing must be legal:
    //          uuid  → field.string
    //          jsonb → field.string
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
                    _ => null, // unreachable (Rule 1)
                };
                if (requiredSubType is not null && field.SubType != requiredSubType)
                {
                    errors.Add(new MetaError(
                        $"field '{field.Name}' @{FIELD_ATTR_DB_COLUMN_TYPE} '{value}' is not valid on " +
                        $"field.{field.SubType} (requires field.{requiredSubType}); allowed pairings: " +
                        $"{DB_COLUMN_TYPE_UUID}→field.{FIELD_SUBTYPE_STRING}, " +
                        $"{DB_COLUMN_TYPE_JSONB}→field.{FIELD_SUBTYPE_STRING}",
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
    //   Cross-attribute validation for field.object + @storage (ADR-0013):
    //     - A field.object ALWAYS requires @objectRef → ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF.
    //       A field.object models a typed nested value; without @objectRef it is
    //       "an oxymoron at the logical layer". Open/untyped JSON uses the physical
    //       @dbColumnType: jsonb escape hatch on field.string, NOT a bare object.
    //       This rule subsumes the legacy @storage-without-@objectRef check
    //       (@storage is only meaningful on a field.object), so missing-@objectRef
    //       now always reports this single, clearer error — one error per node
    //       (the flattened/array check is skipped when @objectRef is absent).
    //       (Previously C# SILENTLY DROPPED a bare field.object in codegen — it is
    //       now a clear load-time error.)
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
                var objectRef = field.OwnAttr(FIELD_ATTR_OBJECT_REF);
                var hasObjectRef = objectRef is string refStr && refStr.Length > 0;

                if (field.SubType == FIELD_SUBTYPE_OBJECT && !hasObjectRef)
                {
                    errors.Add(new MetaError(
                        $"field.object \"{obj.Name}.{field.Name}\" has no @objectRef; " +
                        "a field.object requires @objectRef. For an open/untyped JSON map " +
                        "use @dbColumnType: jsonb on a field.string instead of a bare object.",
                        ErrorCode.ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF,
                        Envelope: field.Source));
                    continue;
                }

                var storage = field.OwnAttr(FIELD_ATTR_STORAGE);
                if (storage is null) continue;

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
    // Pass 8b: ValidateFieldMap
    //   field.map is an open-keyed map (IDictionary<string,V>) stored in a single
    //   jsonb column. Keys are always strings. The value type is set by EXACTLY ONE
    //   of @valueType (a scalar value subtype) or @objectRef (a value-object). This
    //   pass enforces that exactly-one-of rule and that @valueType (when set) names a
    //   known scalar subtype. Cross-port parity: TS validateFieldMap, Java
    //   validateFieldMap, Python _validate_field_map.
    //
    // Ported from validateFieldMap in
    // typescript/packages/metadata/src/loader/validation-passes.ts.
    // =========================================================================

    /// <summary>The scalar value subtypes a field.map's @valueType may name.</summary>
    private static readonly HashSet<string> MapScalarValueSubtypes = new(StringComparer.Ordinal)
    {
        FIELD_SUBTYPE_STRING,
        FIELD_SUBTYPE_INT,
        FIELD_SUBTYPE_LONG,
        FIELD_SUBTYPE_DOUBLE,
        FIELD_SUBTYPE_FLOAT,
        FIELD_SUBTYPE_DECIMAL,
        FIELD_SUBTYPE_BOOLEAN,
        FIELD_SUBTYPE_DATE,
        FIELD_SUBTYPE_TIME,
        FIELD_SUBTYPE_TIMESTAMP,
        FIELD_SUBTYPE_UUID,
    };

    public static IReadOnlyList<MetaError> ValidateFieldMap(MetaData root)
    {
        var errors = new List<MetaError>();

        foreach (var obj in root.OwnChildren().Where(c => c.Type == TYPE_OBJECT))
        {
            foreach (var field in obj.OwnChildren().Where(c => c.Type == TYPE_FIELD))
            {
                if (field.SubType != FIELD_SUBTYPE_MAP) continue;

                var valueType = field.OwnAttr(FIELD_ATTR_VALUE_TYPE);
                var hasValueType = valueType is string vt && vt.Length > 0;
                var objectRef = field.OwnAttr(FIELD_ATTR_OBJECT_REF);
                var hasObjectRef = objectRef is string refStr && refStr.Length > 0;

                if (hasValueType == hasObjectRef)
                {
                    errors.Add(new MetaError(
                        $"field.map \"{obj.Name}.{field.Name}\" must set exactly one of @valueType " +
                        "(a scalar value subtype) or @objectRef (a value-object); " +
                        (hasValueType ? "both are set" : "neither is set"),
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        Envelope: field.Source));
                    continue;
                }

                if (hasValueType && !MapScalarValueSubtypes.Contains((string)valueType!))
                {
                    errors.Add(new MetaError(
                        $"field.map \"{obj.Name}.{field.Name}\" has @valueType \"{valueType}\" which is not " +
                        "a scalar value subtype (string/int/long/double/float/decimal/boolean/date/time/" +
                        "timestamp/uuid). For a value-object-valued map use @objectRef instead.",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
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

                // NOTE: @objectRef existence resolution moved to the validation registry
                // (a declarative ReferenceDescriptor on relationship.* TypeDefinitions,
                // resolved by RegisteredValidation). The M:N rules below stay here for now.

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

    // NOTE: identity.reference @references resolution moved to the validation registry
    // (a declarative ReferenceDescriptor with dottedFieldPath on the identity.reference
    // TypeDefinition, resolved by RegisteredValidation).

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

            // FR-032 (ADR-0032): @payloadRef is FQN after the desugar/sweep — FQN-match.
            var payload = root.OwnChildren()
                .FirstOrDefault(c => c.Type == TYPE_OBJECT && RefMatchesObject(c, payloadRef));
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

    // =========================================================================
    // FR-013 — field-level @readOnly cross-attribute rules.
    //   ERR_READONLY_ASSIGNED_PRIMARY / ERR_READONLY_DOWNGRADE / WARN_READONLY_VALUE_OBJECT
    // Mirrors TS core/field/validate-field-readonly.ts.
    // =========================================================================

    /// <summary>Result of the FR-013 @readOnly validation pass.</summary>
    public sealed record ReadOnlyValidationResult(
        IReadOnlyList<MetaError> Errors,
        IReadOnlyList<LoaderWarning> Warnings);

    public static ReadOnlyValidationResult ValidateFieldReadOnly(MetaData root)
    {
        var errors = new List<MetaError>();
        var warnings = new List<LoaderWarning>();

        foreach (var obj in root.OwnChildren().Where(c => c.Type == TYPE_OBJECT))
        {
            bool isValueObject = obj.SubType == OBJECT_SUBTYPE_VALUE;
            var ownFields = obj.OwnChildren().Where(c => c.Type == TYPE_FIELD).Cast<MetaField>().ToList();

            // 1) WARN_READONLY_VALUE_OBJECT — any @readOnly field child of object.value.
            if (isValueObject)
            {
                foreach (var f in ownFields)
                {
                    if (ReadOnlyFlag(f) == true)
                    {
                        warnings.Add(new LoaderWarning(
                            Code: WarningCodes.WARN_READONLY_VALUE_OBJECT,
                            Message:
                                $"field \"{f.Name}\" on object.value \"{obj.Name}\" declares " +
                                "@readOnly: true; value-objects have no persistence semantics so " +
                                "the read-only contract is advisory (codegen may use it for " +
                                "record/struct treatment).",
                            Source: f.Source));
                    }
                }
            }

            // 2) ERR_READONLY_DOWNGRADE — only the explicit own @readOnly: false case.
            foreach (var ownField in ownFields)
            {
                if (ReadOnlyFlag(ownField) != false) continue;
                var inherited = InheritedReadOnlyField(obj, ownField.Name);
                if (inherited != null && ReadOnlyFlag(inherited) == true)
                {
                    errors.Add(new MetaError(
                        $"field \"{ownField.Name}\" on \"{obj.Name}\" sets @readOnly: false, but the " +
                        "extends-chain parent declares @readOnly: true. Read-only-ness can only be " +
                        "upgraded, not downgraded (FR-013).",
                        ErrorCode.ERR_READONLY_DOWNGRADE,
                        Envelope: ownField.Source));
                }
            }

            // 3) ERR_READONLY_ASSIGNED_PRIMARY — @readOnly: true on a field used in an
            //    identity.primary with @generation: "assigned" (effective tree).
            if (!isValueObject)
            {
                var assigned = PrimaryAssignedFieldNames(obj);
                if (assigned.Count > 0)
                {
                    foreach (var f in ownFields)
                    {
                        if (!assigned.Contains(f.Name)) continue;
                        if (ReadOnlyFlag(f) != true) continue;
                        errors.Add(new MetaError(
                            $"field \"{f.Name}\" on \"{obj.Name}\" is @readOnly: true AND the target " +
                            "of identity.primary with @generation: \"assigned\"; the application has " +
                            "no path to populate the identity value (FR-013).",
                            ErrorCode.ERR_READONLY_ASSIGNED_PRIMARY,
                            Envelope: f.Source));
                    }
                }
            }
        }

        return new ReadOnlyValidationResult(errors.AsReadOnly(), warnings.AsReadOnly());
    }

    private static bool? ReadOnlyFlag(MetaField field) => field.OwnAttr(FIELD_ATTR_READ_ONLY) switch
    {
        bool b => b,
        string s => string.Equals(s, "true", StringComparison.OrdinalIgnoreCase),
        _ => null,
    };

    private static MetaField? InheritedReadOnlyField(MetaData obj, string name)
    {
        var cursor = obj.SuperData;
        while (cursor != null)
        {
            var f = cursor.OwnChildren()
                .FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == name) as MetaField;
            if (f != null) return f;
            cursor = cursor.SuperData;
        }
        return null;
    }

    private static HashSet<string> PrimaryAssignedFieldNames(MetaData obj)
    {
        var outNames = new HashSet<string>();
        foreach (var id in obj.Children().OfType<MetaIdentity>())
        {
            if (!id.IsPrimary()) continue;
            if (id.OwnAttr(IDENTITY_ATTR_GENERATION) as string != GENERATION_ASSIGNED) continue;
            foreach (var fn in id.Fields) outNames.Add(fn);
        }
        return outNames;
    }

    // =========================================================================
    // FR-014 — TPH discriminator cross-attribute rules.
    //   ERR_DISCRIMINATOR_FIELD_NOT_FOUND / _VALUE_DUPLICATE / _VALUE_MISSING /
    //   _VALUE_TYPE_MISMATCH. Mirrors TS core/object/validate-discriminator.ts.
    // =========================================================================

    private static readonly HashSet<string> NumericDiscriminatorSubtypes = new()
    {
        FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG,
    };

    public static IReadOnlyList<MetaError> ValidateDiscriminator(MetaData root)
    {
        var errors = new List<MetaError>();
        var entities = root.OwnChildren()
            .Where(c => c.Type == TYPE_OBJECT && c.SubType == OBJECT_SUBTYPE_ENTITY)
            .ToList();

        // Pass 1: @discriminator name resolution (own + inherited fields).
        foreach (var obj in entities)
        {
            if (obj.OwnAttr(OBJECT_ATTR_DISCRIMINATOR) is not string disc || disc.Length == 0) continue;
            if (FindFieldOnEntity(obj, disc) == null)
            {
                errors.Add(new MetaError(
                    $"object.entity \"{obj.Name}\" @discriminator: \"{disc}\" does not name a field on " +
                    "this entity (checked own children and the extends chain)",
                    ErrorCode.ERR_DISCRIMINATOR_FIELD_NOT_FOUND,
                    Envelope: obj.Source));
            }
        }

        // Pass 2: @discriminatorValue type-check + collect bindings per root.
        var bindingsByRoot = new Dictionary<MetaData, List<(MetaData Subtype, string Value)>>();
        var order = new List<MetaData>();
        foreach (var obj in entities)
        {
            if (obj.OwnAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is not string value || value.Length == 0) continue;
            var discRoot = FindDiscriminatorRoot(obj);
            if (discRoot == null) continue;
            if (discRoot.OwnAttr(OBJECT_ATTR_DISCRIMINATOR) is not string fieldName) continue;
            var field = FindFieldOnEntity(discRoot, fieldName);
            if (field == null) continue; // root's own field-not-found already fires

            if (field.SubType == FIELD_SUBTYPE_ENUM)
            {
                var members = field.EffectiveEnumValues ?? new List<string>();
                if (!members.Contains(value))
                {
                    errors.Add(new MetaError(
                        $"object.entity \"{obj.Name}\" @discriminatorValue: \"{value}\" is not a member of " +
                        $"the discriminator enum field \"{fieldName}\" @values [{string.Join(", ", members)}]",
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
                        Envelope: obj.Source));
                }
            }
            else if (NumericDiscriminatorSubtypes.Contains(field.SubType))
            {
                if (!Regex.IsMatch(value, "^-?\\d+$"))
                {
                    errors.Add(new MetaError(
                        $"object.entity \"{obj.Name}\" @discriminatorValue: \"{value}\" does not coerce to " +
                        $"numeric discriminator field \"{fieldName}\" (field.{field.SubType})",
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
                        Envelope: obj.Source));
                }
            }
            // string (and other) discriminator types accept any value.

            if (!bindingsByRoot.TryGetValue(discRoot, out var list))
            {
                list = new List<(MetaData, string)>();
                bindingsByRoot[discRoot] = list;
                order.Add(discRoot);
            }
            list.Add((obj, value));
        }

        // Pass 3: ERR_DISCRIMINATOR_VALUE_DUPLICATE within each root's subtypes.
        foreach (var discRoot in order)
        {
            var seen = new Dictionary<string, MetaData>();
            foreach (var (subtype, value) in bindingsByRoot[discRoot])
            {
                if (seen.TryGetValue(value, out var prev))
                {
                    errors.Add(new MetaError(
                        $"object.entity \"{subtype.Name}\" @discriminatorValue: \"{value}\" duplicates the " +
                        $"value already claimed by \"{prev.Name}\"",
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_DUPLICATE,
                        Envelope: subtype.Source));
                }
                else
                {
                    seen[value] = subtype;
                }
            }
        }

        // Pass 4: ERR_DISCRIMINATOR_VALUE_MISSING on concrete subtypes.
        foreach (var obj in entities)
        {
            if (obj.IsAbstract) continue;
            if (obj.OwnAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is string) continue;
            if (obj.OwnAttr(OBJECT_ATTR_DISCRIMINATOR) is string) continue; // a root
            var discRoot = FindDiscriminatorRoot(obj);
            if (discRoot == null || ReferenceEquals(discRoot, obj)) continue;
            errors.Add(new MetaError(
                $"object.entity \"{obj.Name}\" extends the @discriminator-bearing root \"{discRoot.Name}\" " +
                "but is missing @discriminatorValue (required on every concrete subtype)",
                ErrorCode.ERR_DISCRIMINATOR_VALUE_MISSING,
                Envelope: obj.Source));
        }

        return errors.AsReadOnly();
    }

    private static MetaField? FindFieldOnEntity(MetaData entity, string name)
    {
        var f = entity.OwnChildren().FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == name) as MetaField;
        if (f != null) return f;
        var cursor = entity.SuperData;
        while (cursor != null)
        {
            f = cursor.OwnChildren().FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == name) as MetaField;
            if (f != null) return f;
            cursor = cursor.SuperData;
        }
        return null;
    }

    private static MetaData? FindDiscriminatorRoot(MetaData entity)
    {
        var cursor = entity;
        while (cursor != null)
        {
            if (cursor.OwnAttr(OBJECT_ATTR_DISCRIMINATOR) is string v && v.Length > 0) return cursor;
            cursor = cursor.SuperData;
        }
        return null;
    }

    // =========================================================================
    // FR-015 — source.rdb @parameterRef typed-input rules.
    //   ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND / _UNRESOLVED / _NOT_VALUE_OBJECT /
    //   _PASSTHROUGH_TYPE_MISMATCH. Mirrors TS persistence/source/validate-source-parameter-ref.ts.
    // =========================================================================

    private static readonly HashSet<string> CallableKinds = new()
    {
        SOURCE_KIND_STORED_PROC, SOURCE_KIND_TABLE_FUNCTION,
    };

    public static IReadOnlyList<MetaError> ValidateSourceParameterRef(MetaData root)
    {
        var errors = new List<MetaError>();

        // Pre-index every object by name, fqn AND resolution key. FR-032 (ADR-0032):
        // @parameterRef is FQN after the desugar/sweep (e.g. "acme::ParamVO"), which
        // is the canonical ResolutionKey() (objects keep a bare Fqn() per FR5d), so
        // the index must carry that key too. Mirrors TS/Java FQN-tolerant resolution.
        var index = new Dictionary<string, MetaData>();
        foreach (var obj in root.OwnChildren().Where(c => c.Type == TYPE_OBJECT))
        {
            index[obj.Name] = obj;
            index[obj.Fqn()] = obj;
            index[obj.ResolutionKey()] = obj;
        }

        foreach (var obj in root.OwnChildren().Where(c => c.Type == TYPE_OBJECT))
        {
            foreach (var source in obj.OwnChildren()
                .Where(c => c.Type == TYPE_SOURCE && c.SubType == SOURCE_SUBTYPE_RDB && c is MetaSource)
                .Cast<MetaSource>())
            {
                if (source.OwnAttr(SOURCE_ATTR_PARAMETER_REF) is not string refName || refName.Length == 0) continue;

                // ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND — before resolution.
                if (!CallableKinds.Contains(source.EffectiveKind))
                {
                    errors.Add(new MetaError(
                        $"source.rdb on object \"{obj.Name}\" has @parameterRef but @kind is " +
                        $"\"{source.EffectiveKind}\"; only \"storedProc\" or \"tableFunction\" accept parameters",
                        ErrorCode.ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND,
                        Envelope: source.Source));
                    continue;
                }

                if (!index.TryGetValue(refName, out var target))
                {
                    errors.Add(new MetaError(
                        $"source.rdb on object \"{obj.Name}\" @parameterRef = \"{refName}\" does not resolve " +
                        "to any known object",
                        ErrorCode.ERR_PARAMETER_REF_UNRESOLVED,
                        Envelope: source.Source));
                    continue;
                }

                if (target.SubType != OBJECT_SUBTYPE_VALUE)
                {
                    string reason = target.SubType == OBJECT_SUBTYPE_ENTITY
                        ? "an object.entity (entities have identity; parameter shapes are value-objects)"
                        : $"an object.{target.SubType}";
                    errors.Add(new MetaError(
                        $"source.rdb on object \"{obj.Name}\" @parameterRef = \"{refName}\" resolves to " +
                        $"{reason}; use an object.value",
                        ErrorCode.ERR_PARAMETER_REF_NOT_VALUE_OBJECT,
                        Envelope: source.Source));
                    continue;
                }

                // ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH per parameter field.
                foreach (var paramField in target.OwnChildren().Where(c => c.Type == TYPE_FIELD).Cast<MetaField>())
                {
                    var passthrough = paramField.OwnChildren()
                        .FirstOrDefault(c => c.Type == TYPE_ORIGIN && c.SubType == ORIGIN_SUBTYPE_PASSTHROUGH);
                    if (passthrough == null) continue;
                    if (passthrough.OwnAttr(ORIGIN_PASSTHROUGH_ATTR_FROM) is not string from || from.Length == 0) continue;
                    int dot = from.IndexOf('.');
                    if (dot < 0) continue;
                    string targetEntityName = from.Substring(0, dot);
                    string targetFieldName = from.Substring(dot + 1);
                    if (!index.TryGetValue(targetEntityName, out var targetEntity)) continue;
                    var targetField = targetEntity.OwnChildren()
                        .FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == targetFieldName) as MetaField;
                    if (targetField == null) continue;
                    if (paramField.SubType != targetField.SubType)
                    {
                        errors.Add(new MetaError(
                            $"parameter field \"{paramField.Name}\" (field.{paramField.SubType}) on @parameterRef " +
                            $"\"{refName}\" uses origin.passthrough @from: \"{from}\", but " +
                            $"{targetEntity.Name}.{targetFieldName} is field.{targetField.SubType}; types must match",
                            ErrorCode.ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH,
                            Envelope: paramField.Source));
                    }
                }
            }
        }

        return errors.AsReadOnly();
    }
}
