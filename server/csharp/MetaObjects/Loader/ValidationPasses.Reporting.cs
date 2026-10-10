// FR-044 — cross-node rules for the reporting vocabulary (ValidationPasses.ValidateReporting).
//
// Ported rule-for-rule, WITH THE SAME MESSAGE TEXT, from the TS reference
// server/typescript/packages/metadata/src/loader/reporting-validation.ts. The rule ids
// (D1…F2) match the rule table in the FR-044 plan (R8, R9, M7 and M8: Table B of
// docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md) and the error
// fixtures in fixtures/conformance/error-*; the fixtures are the contract.
//
// Two design rules hold throughout, so one broken rule yields exactly one error:
//   - No cascades. A member that fails a structural rule is not checked further
//     (a dimension whose @via fails D2 skips D1/D3/D4; a measure that fails one
//     of M1–M4, or whose @default is a fraction, skips M7/M8; a report whose
//     @from fails R1 skips R2/R3/R6/R7, R8/R9 and its @filter; a report whose
//     @spine fails R8 skips R9, and R9 skips a dimension whose @via fails D2; an
//     invalid @dimensions/@measures item derives no report field for R6).
//
// A fractional measure @default: the TypeScript reference refuses it here, in
// CheckMeasure, because its generic attr.int check lets a fraction through. This port's
// generic attr-type check (ValidateAttrSchema, ValueMatchesType) already refuses it with
// ERR_BAD_ATTR_VALUE on the measure node, so no second error is added here; CheckMeasure
// only skips M7/M8 for it, as the reference does.
//   - Each error's source is the offending node (the dimension / measure / segment /
//     report, or for R4/R5 the declared child), so a conformance fixture's jsonPath
//     points at it.
//
// Inheritance (ADR-0039): an entity's members are read through Children(), so a member
// declared on an abstract base is validated against every entity that inherits it.
// Members declared on an entity are validated first (pass 1), then inherited ones
// (pass 2); an error already reported for the same node with the same message is not
// repeated, so a broken base member is reported ONCE, and a failure that only an
// inheritor exposes carries " (inherited by '<entity>')".

using System.Text.Encodings.Web;
using System.Text.Json;
using MetaObjects.Core.Reporting;
using MetaObjects.Meta;

namespace MetaObjects.Loader;

public static partial class ValidationPasses
{
    // -------------------------------------------------------------------------
    // Closed sets the rules consult
    // -------------------------------------------------------------------------

    /// <summary>M4 — the field subtypes <c>sum</c>/<c>avg</c> accept.</summary>
    private static readonly string[] ReportingNumericFieldSubtypes =
    [
        FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE,
        FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY,
    ];

    /// <summary>M4 — the field subtypes <c>min</c>/<c>max</c> refuse (no total order).</summary>
    private static readonly string[] ReportingUnorderedFieldSubtypes =
        [FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP];

    /// <summary>D3 / F2 — the temporal field subtypes.</summary>
    private static readonly string[] ReportingTemporalFieldSubtypes = [FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIMESTAMP];

    /// <summary>F2 — the only ops a relative-date value may sit under.</summary>
    private static readonly string[] ReportingRelativeDateOps = [FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE];

    /// <summary>JSON.stringify-equivalent options for values quoted in a message.</summary>
    private static readonly JsonSerializerOptions ReportingMessageJson = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // =========================================================================
    // Entry point
    // =========================================================================

    /// <summary>
    /// FR-044 — validate the reporting vocabulary: dimensions (D1–D4), measures (M1–M6),
    /// segment / measure / report row scopes (S1, F2), reports (R1–R7), and relative-date
    /// filter values outside a reporting host (F1). <paramref name="registry"/> classifies
    /// which own attrs are <c>attr.filter</c>-typed for the F1 walk (the TS reference reads
    /// the attr node's subType, which C# does not materialise for inline attrs).
    /// </summary>
    public static IReadOnlyList<MetaError> ValidateReporting(MetaData root, TypeRegistry registry)
    {
        var sink = new ReportingErrorSink();
        // ADR-0039: root has no super; Children()==OwnChildren() but resolving is the default.
        var objects = root.Children().Where(c => c.Type == TYPE_OBJECT).ToList();
        var entities = objects.Where(o => o.SubType == OBJECT_SUBTYPE_ENTITY).ToList();

        // Pass 1: every member against the entity that declares it (an abstract base
        // included — its members must be self-consistent). Pass 2: inherited members
        // against each inheriting entity, so an override that breaks one is caught.
        foreach (var entity in entities) CheckEntityMembers(root, entity, true, sink);
        foreach (var entity in entities) CheckEntityMembers(root, entity, false, sink);

        foreach (var report in objects.Where(o => o.SubType == OBJECT_SUBTYPE_REPORT))
        {
            CheckReport(root, report, sink);
        }

        // F1 on every host that is not a reporting host.
        CheckNoRelativeDates(root, registry, sink);
        return sink.Errors.AsReadOnly();
    }

    /// <summary>
    /// Collects errors, dropping a repeat — the shape an unmodified inherited member's
    /// failure takes when it is re-validated under an inheriting entity. A message is
    /// <c>head + suffix + body</c>. A pass-2 error (suffix <c>" (inherited by '&lt;entity&gt;')"</c>)
    /// is dropped when pass 1 already reported the same failure without a suffix, or the
    /// same inheritor already reported it; a second inheritor's identical failure is still
    /// reported, under its own name.
    /// </summary>
    private sealed class ReportingErrorSink
    {
        public readonly List<MetaError> Errors = [];
        private readonly Dictionary<MetaData, HashSet<string>> _seen = new(ReferenceEqualityComparer.Instance);

        public void Push(MetaData node, ErrorCode code, string head, string body, string suffix = "")
        {
            // `baseKey` drops a pass-2 copy of a failure pass 1 already reported; a pass-2
            // entry is keyed WITH its suffix, so two inheritors that break the same
            // inherited member the same way are each reported.
            string baseKey = $"{code}\u0000{head}{body}";
            string key = $"{baseKey}\u0000{suffix}";
            if (!_seen.TryGetValue(node, out var keys))
            {
                keys = new HashSet<string>(StringComparer.Ordinal);
                _seen[node] = keys;
            }
            if (keys.Contains(baseKey) || keys.Contains(key)) return;
            keys.Add(suffix == "" ? baseKey : key);
            Errors.Add(new MetaError($"{head}{suffix}{body}", code, Envelope: node.Source));
        }
    }

    // -------------------------------------------------------------------------
    // Shared helpers
    // -------------------------------------------------------------------------

    /// <summary>
    /// Split a dotted <c>Owner.child[.child…]</c> reference at the first <c>.</c> after the
    /// last <c>::</c>, so an FQN owner (<c>acme::shop::Purchase.program</c>) keeps its
    /// package. Null when there is no owner, no child, or an empty child segment.
    /// </summary>
    private static (string Owner, string[] Path)? ReportingSplitDotted(string reference)
    {
        int lastSep = reference.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        int segStart = lastSep == -1 ? 0 : lastSep + PACKAGE_SEPARATOR.Length;
        int dot = reference.IndexOf(CHILD_REF_SEPARATOR, segStart, StringComparison.Ordinal);
        if (dot <= segStart) return null;
        string[] path = reference[(dot + CHILD_REF_SEPARATOR.Length)..].Split(CHILD_REF_SEPARATOR);
        if (path.Any(s => s == "")) return null;
        return (reference[..dot], path);
    }

    /// <summary>True when <paramref name="candidate"/> is <paramref name="entity"/> or an entity it extends.</summary>
    // Internal: the report shape (ReportShapes) applies the same test, so it uses this one.
    internal static bool IsSelfOrAncestor(MetaData? candidate, MetaData entity)
    {
        var visited = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
        for (MetaData? n = entity; n is not null && !visited.Contains(n); n = n.SuperData)
        {
            if (ReferenceEquals(n, candidate)) return true;
            visited.Add(n);
        }
        return false;
    }

    private static MetaData? ReportingChildOfType(MetaData obj, string type, string name) =>
        // ADR-0039: resolving — inherited members (via extends) are visible. Keyed by
        // (type, name): an entity may carry a same-named dimension and relationship.
        obj.Children().FirstOrDefault(c => c.Type == type && c.Name == name);

    private static MetaData? ReportingFieldOf(MetaData obj, string name) =>
        ReportingChildOfType(obj, TYPE_FIELD, name);

    private static IReadOnlyDictionary<string, object?>? AsPlainObject(object? v) =>
        v as IReadOnlyDictionary<string, object?>;

    /// <summary>An object operand carrying a <c>now</c> key — a relative-date value,
    /// well-formed (exactly <c>{ now }</c>) or not. A malformed one is refused, never read as data.</summary>
    private static bool IsRelativeValue(object? v) =>
        v is IReadOnlyDictionary<string, object?> o && o.ContainsKey(FILTER_RELATIVE_NOW);

    /// <summary>True for a well-formed relative value: exactly the one key <c>now</c>.</summary>
    private static bool IsExactRelativeValue(IReadOnlyDictionary<string, object?> v) => v.Count == 1;

    /// <summary>The relative value an op's operand carries: the operand itself, or one inside an array operand.</summary>
    private static IReadOnlyDictionary<string, object?>? RelativeOperand(object? v)
    {
        if (IsRelativeValue(v)) return (IReadOnlyDictionary<string, object?>)v!;
        if (v is IReadOnlyList<object?> list)
        {
            return list.FirstOrDefault(IsRelativeValue) as IReadOnlyDictionary<string, object?>;
        }
        return null;
    }

    /// <summary>Deep search of an operand VALUE: is a relative value (well-formed or not) anywhere inside it?</summary>
    private static bool OperandContainsRelativeValue(object? v)
    {
        if (IsRelativeValue(v)) return true;
        if (v is IReadOnlyList<object?> list) return list.Any(OperandContainsRelativeValue);
        if (v is IReadOnlyDictionary<string, object?> obj) return obj.Values.Any(OperandContainsRelativeValue);
        return false;
    }

    /// <summary>
    /// Does a filter contain a relative value in any operand? Walks the filter grammar
    /// (<c>and</c>/<c>or</c> arrays, <c>{ field: { op: operand } }</c>) so only operand VALUES
    /// are searched: a field key that happens to be named <c>now</c> is a field, not a relative date.
    /// </summary>
    private static bool FilterContainsRelativeValue(object? filter)
    {
        if (filter is not IReadOnlyDictionary<string, object?> f) return false;
        foreach (var (key, clause) in f)
        {
            if (key == FILTER_COMPOSE_OR || key == FILTER_COMPOSE_AND)
            {
                if (clause is IReadOnlyList<object?> subs && subs.Any(FilterContainsRelativeValue)) return true;
                continue;
            }
            if (IsRelativeValue(clause)) return true; // un-desugared shorthand
            if (clause is IReadOnlyDictionary<string, object?> ops && ops.Values.Any(OperandContainsRelativeValue))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>The JS <c>JSON.stringify</c> equivalent used in messages.</summary>
    private static string JsonStringify(object? v) => JsonSerializer.Serialize(v, ReportingMessageJson);

    private static string QuoteValue(object? v) => v is string s ? s : JsonStringify(v);

    /// <summary><c>&lt;type&gt;.&lt;subType&gt; '&lt;name&gt;'</c>, or just <c>&lt;type&gt;.&lt;subType&gt;</c> for an unnamed node.</summary>
    private static string ReportingChildLabel(MetaData node)
    {
        string head = $"{node.Type}.{node.SubType}";
        return node.Name != "" ? $"{head} '{node.Name}'" : head;
    }

    /// <summary><c>&lt;type&gt;.&lt;subType&gt; '&lt;FQN&gt;'</c> for a root-level object, else its
    /// child label plus <c> in &lt;parent label&gt;</c>.</summary>
    private static string ReportingNodeLabel(MetaData node)
    {
        var parent = node.Parent;
        if (parent is null || parent.Parent is null)
        {
            return $"{node.Type}.{node.SubType} '{node.ResolutionKey()}'";
        }
        return $"{ReportingChildLabel(node)} in {ReportingNodeLabel(parent)}";
    }

    // -------------------------------------------------------------------------
    // D1–D4, M1–M6, S1/F2 — members of an object.entity
    // -------------------------------------------------------------------------

    /// <summary>Validation context for one member of one entity.</summary>
    /// <param name="Root">The metadata root.</param>
    /// <param name="Host">The entity whose Children() the member was reached through.</param>
    /// <param name="Declaring">The entity that declares the member (the host, or an ancestor of it).</param>
    /// <param name="Label"><c>&lt;kind&gt; '&lt;name&gt;' on entity '&lt;declaring FQN&gt;'</c> — every member message starts with it.</param>
    /// <param name="Suffix"><c>""</c> in pass 1; <c> (inherited by '&lt;host FQN&gt;')</c> in pass 2.</param>
    /// <param name="Sink">The error sink.</param>
    private sealed record MemberCtx(
        MetaData Root, MetaData Host, MetaData Declaring, string Label, string Suffix, ReportingErrorSink Sink);

    /// <summary>
    /// The FQN a member message names for <paramref name="entity"/>: the DECLARING entity in
    /// place of the host, so a failure is worded identically whichever entity reached the
    /// member (the suffix names the inheritor) and the sink's repeat test holds.
    /// </summary>
    private static string Shown(MemberCtx ctx, MetaData entity) =>
        (ReferenceEquals(entity, ctx.Host) ? ctx.Declaring : entity).ResolutionKey();

    private static void CheckEntityMembers(MetaData root, MetaData entity, bool declaredHere, ReportingErrorSink sink)
    {
        // ADR-0039: resolving — inherited members are validated against this entity.
        foreach (var member in entity.Children())
        {
            if (member.Type != TYPE_DIMENSION && member.Type != TYPE_MEASURE && member.Type != TYPE_SEGMENT) continue;
            var declaring = member.Parent ?? entity;
            if (ReferenceEquals(declaring, entity) != declaredHere) continue;
            var ctx = new MemberCtx(
                root,
                entity,
                declaring,
                $"{member.Type} '{member.Name}' on entity '{declaring.ResolutionKey()}'",
                declaredHere ? "" : $" (inherited by '{entity.ResolutionKey()}')",
                sink);
            switch (member)
            {
                case MetaDimension dim:
                    CheckDimension(ctx, dim);
                    break;
                case MetaMeasure measure:
                    CheckMeasure(ctx, measure);
                    break;
                case MetaSegment segment:
                    var filter = segment.Filter();
                    if (filter is not null)
                    {
                        CheckReportingFilter(filter, entity, declaring.ResolutionKey(), ctx.Label, segment, ctx.Suffix, sink);
                    }
                    break;
            }
        }
    }

    private static void CheckDimension(MemberCtx ctx, MetaDimension dim)
    {
        void Err(string message) =>
            ctx.Sink.Push(dim, ErrorCode.ERR_INVALID_DIMENSION, ctx.Label, $": {message}", ctx.Suffix);

        // D2 — the @via walk; its terminal is the entity @of must name.
        MetaData ofEntity = ctx.Host;
        string? via = dim.Via();
        if (via is not null)
        {
            var terminal = WalkToOneVia(ctx.Root, ctx.Host, via, Err, D2Walk(ctx.Declaring));
            if (terminal is null) return;
            ofEntity = terminal;
        }

        // D1 — @of is Entity.field on the owning entity (or the @via terminal).
        string? of = dim.Of();
        if (of is null) return; // missing @of is ERR_MISSING_REQUIRED_ATTR (attr schema pass)
        var parts = ReportingSplitDotted(of);
        if (parts is null || parts.Value.Path.Length != 1)
        {
            Err($"@of '{of}' must be Entity.field.");
            return;
        }
        var named = NamingRefs.ResolveObjectRef(ctx.Root, parts.Value.Owner, NamingRefs.EffectivePackage(ctx.Declaring));
        if (!IsSelfOrAncestor(named, ofEntity))
        {
            if (via is null)
            {
                Err($"@of '{of}' must name a field of the owning entity '{ctx.Declaring.ResolutionKey()}'. " +
                    "Reach another entity's field with @via.");
            }
            else
            {
                Err($"@of '{of}' must name a field of '{Shown(ctx, ofEntity)}', the entity @via '{via}' reaches.");
            }
            return;
        }
        string fieldName = parts.Value.Path[0];
        var field = ReportingFieldOf(ofEntity, fieldName);
        if (field is null)
        {
            Err($"@of '{of}' names no field '{fieldName}' on '{Shown(ctx, ofEntity)}'.");
            return;
        }

        if (!dim.IsTime()) return;
        // D3 — a time dimension groups a date or timestamp.
        if (!ReportingTemporalFieldSubtypes.Contains(field.SubType))
        {
            Err($"a time dimension's @of must be a field.date or field.timestamp, but '{of}' is field.{field.SubType}.");
            return;
        }
        // D4 — a date has no hour.
        if (field.SubType == FIELD_SUBTYPE_DATE && dim.Grains().Contains(GRAIN_HOUR))
        {
            Err($"grain 'hour' is impossible on '{of}', a field.date (a date has no hour). Remove 'hour' from @grains.");
        }
    }

    /// <summary>
    /// What a to-one walk resolves against and how its messages name it. D2 walks a
    /// dimension's @via (<see cref="D2Walk"/>); R8 walks a report's @spine from @from
    /// (<see cref="SpineWalk"/>). Every difference between the two is a field here, so each
    /// port copies one explicit rule.
    /// </summary>
    /// <param name="Attr">The attribute holding the path: <c>via</c> (D2) or <c>spine</c> (R8).</param>
    /// <param name="OwnerPkg">The package Owner resolves in (ADR-0042): the declaring entity's (D2) or the report's (R8).</param>
    /// <param name="HostName">The FQN named for the walk's first entity: the declaring entity (D2) or @from (R8).</param>
    /// <param name="Start">What Owner must be: <c>the owning entity '&lt;FQN&gt;'</c> (D2) or <c>@from '&lt;FQN&gt;'</c> (R8).</param>
    /// <param name="StartShort">The same, in the malformed-path message: <c>the owning entity</c> (D2) or <c>@from '&lt;FQN&gt;'</c> (R8).</param>
    /// <param name="ToOneReason">The sentence that ends the to-many message: why only to-one hops are followed.</param>
    private sealed record ToOneWalk(
        string Attr, string OwnerPkg, string HostName, string Start, string StartShort, string ToOneReason);

    /// <summary>D2 — a dimension's @via, declared on <paramref name="declaring"/>. Reproduces D2's messages exactly.</summary>
    private static ToOneWalk D2Walk(MetaData declaring)
    {
        string declaringKey = declaring.ResolutionKey();
        return new ToOneWalk(
            Attr: REPORTING_ATTR_VIA,
            OwnerPkg: NamingRefs.EffectivePackage(declaring),
            HostName: declaringKey,
            Start: $"the owning entity '{declaringKey}'",
            StartShort: "the owning entity",
            ToOneReason:
                "A dimension follows only @cardinality: one relationships and identity.reference hops, so grouping " +
                "can never multiply the measured rows.");
    }

    /// <summary>R8 — a report's @spine, started at @from (<paramref name="fromKey"/>); Owner resolves in the report's package.</summary>
    private static ToOneWalk SpineWalk(MetaData report, string fromKey) =>
        new(
            Attr: OBJECT_REPORT_ATTR_SPINE,
            OwnerPkg: NamingRefs.EffectivePackage(report),
            HostName: fromKey,
            Start: $"@from '{fromKey}'",
            StartShort: $"@from '{fromKey}'",
            ToOneReason:
                "A @spine follows only @cardinality: one relationships and identity.reference hops, so each fact row " +
                "joins at most one row of the spine entity and is never counted twice.");

    /// <summary>
    /// Walk <c>Owner.hop[.hop...]</c> from <paramref name="host"/>: Owner is the host or an
    /// entity it extends, and every hop is a to-one <c>relationship.*</c> or an
    /// <c>identity.reference</c>. Returns the terminal entity, or null after reporting the
    /// first failure. D2 and R8 both run it; <paramref name="walk"/> says which.
    /// </summary>
    private static MetaData? WalkToOneVia(MetaData root, MetaData host, string via, Action<string> err, ToOneWalk walk)
    {
        string named = $"@{walk.Attr} '{via}'";
        string NameOf(MetaData entity) => ReferenceEquals(entity, host) ? walk.HostName : entity.ResolutionKey();
        var parts = ReportingSplitDotted(via);
        if (parts is null)
        {
            err($"{named} must be Owner.hop[.hop...], starting at {walk.StartShort}.");
            return null;
        }
        var owner = NamingRefs.ResolveObjectRef(root, parts.Value.Owner, walk.OwnerPkg);
        if (!IsSelfOrAncestor(owner, host))
        {
            err($"{named} must start at {walk.Start}.");
            return null;
        }
        MetaData current = host;
        foreach (string hopName in parts.Value.Path)
        {
            var hop =
                ReportingChildOfType(current, TYPE_RELATIONSHIP, hopName) ??
                // ADR-0039: resolving — an inherited identity.reference is a hop just the same.
                current.Children().FirstOrDefault(c =>
                    c.Type == TYPE_IDENTITY && c.SubType == IDENTITY_SUBTYPE_REFERENCE && c.Name == hopName);
            if (hop is null)
            {
                err($"{named} names '{hopName}', which is not a relationship or identity.reference of " +
                    $"'{NameOf(current)}'.");
                return null;
            }
            bool isReference = hop.Type == TYPE_IDENTITY;
            // ADR-0039: resolving — @cardinality may be inherited via extends.
            if (!isReference && !Equals(hop.Attr(RELATIONSHIP_ATTR_CARDINALITY), CARDINALITY_ONE))
            {
                err($"{named} crosses relationship '{hopName}' on '{NameOf(current)}', which is not to-one. " +
                    walk.ToOneReason);
                return null;
            }
            // ADR-0039: resolving — the hop target attr may be inherited via extends.
            var targetRef = hop.Attr(isReference ? IDENTITY_REFERENCE_ATTR_REFERENCES : RELATIONSHIP_ATTR_OBJECT_REF);
            // ADR-0042 — a hop target resolves in the package of the entity declaring the hop.
            var target = targetRef is string tr
                ? NamingRefs.ResolveObjectRef(root, tr, NamingRefs.EffectivePackage(current))
                : null;
            if (target is null)
            {
                err($"{named} hop '{hopName}' on '{NameOf(current)}' targets no object.");
                return null;
            }
            current = target;
        }
        return current;
    }

    private static void CheckMeasure(MemberCtx ctx, MetaMeasure measure)
    {
        void Err(string message) =>
            ctx.Sink.Push(measure, ErrorCode.ERR_INVALID_MEASURE, ctx.Label, $": {message}", ctx.Suffix);

        // The type rule — a measure's @default is a whole number. ValidateAttrSchema already
        // refuses a fraction (and a non-number) with ERR_BAD_ATTR_VALUE on this node (see the
        // file header), so nothing is reported here. A fraction only skips M7/M8: one mistake,
        // one error. ADR-0039: resolving — the raw attribute, inherited or not.
        var declaredDefault = measure.Attr(REPORTING_ATTR_DEFAULT);
        bool fractionalDefault = declaredDefault is double d && double.IsFinite(d) && d != Math.Floor(d);

        if (measure.IsRatio())
        {
            CheckRatioOperands(ctx, measure, Err);
            return;
        }
        if (measure.SubType != MEASURE_SUBTYPE_AGGREGATE) return;

        bool clean = CheckAggregateColumns(ctx, measure, Err, out var ofField);

        // M7 / M8 — where a @default can apply. Only when M1–M4 passed and the @default is
        // not a fraction: one mistake, one error. The presence test reads the raw attribute,
        // so a non-number value on a count still reports M7 beside the attribute type error.
        if (clean && !fractionalDefault && declaredDefault is not null)
        {
            string? agg = measure.Agg();
            if (agg == AGG_COUNT)
            {
                Err("@default cannot apply to @agg: count. A count is never null (it is 0 when nothing matches); " +
                    "remove @default.");
            }
            else if ((agg == AGG_MIN || agg == AGG_MAX) &&
                     ofField is not null &&
                     !ReportingNumericFieldSubtypes.Contains(ofField.SubType))
            {
                Err($"@default is a number, but '{measure.OfColumns()[0]}', the @of of @agg '{agg}', is a " +
                    $"field.{ofField.SubType}. A default is supported on numeric measures only.");
            }
        }

        // M5 — @segment names a segment of the owning entity.
        string? segment = measure.SegmentName();
        if (segment is not null && ReportingChildOfType(ctx.Host, TYPE_SEGMENT, segment) is null)
        {
            Err($"@segment '{segment}' names no segment of '{ctx.Declaring.ResolutionKey()}'.");
        }

        // S1 / F2 — the measure's own row scope.
        var filter = measure.Filter();
        if (filter is not null)
        {
            CheckReportingFilter(filter, ctx.Host, ctx.Declaring.ResolutionKey(), ctx.Label, measure, ctx.Suffix, ctx.Sink);
        }
    }

    /// <summary>
    /// M1–M4, in order; the first failure stops the chain (no M2+M3 double report).
    /// Returns false when one of them fired; otherwise <paramref name="field"/> is the single
    /// resolved @of field (null for a tuple), for M7/M8.
    /// </summary>
    private static bool CheckAggregateColumns(MemberCtx ctx, MetaMeasure measure, Action<string> err, out MetaData? field)
    {
        field = null;
        string? agg = measure.Agg();
        var columns = measure.OfColumns();

        // M1 — every @of item is a field of the owning entity.
        var fields = new List<MetaData>();
        foreach (string item in columns)
        {
            var parts = ReportingSplitDotted(item);
            if (parts is null || parts.Value.Path.Length != 1)
            {
                err($"@of '{item}' must be Entity.field.");
                return false;
            }
            var named = NamingRefs.ResolveObjectRef(ctx.Root, parts.Value.Owner, NamingRefs.EffectivePackage(ctx.Declaring));
            if (!IsSelfOrAncestor(named, ctx.Host))
            {
                err($"@of '{item}' must name a field of the owning entity '{ctx.Declaring.ResolutionKey()}'. " +
                    "A measure aggregates its own entity's rows; declare it on the entity that owns the column.");
                return false;
            }
            var ofField = ReportingFieldOf(ctx.Host, parts.Value.Path[0]);
            if (ofField is null)
            {
                err($"@of '{item}' names no field '{parts.Value.Path[0]}' on '{ctx.Declaring.ResolutionKey()}'.");
                return false;
            }
            fields.Add(ofField);
        }

        // M2 — a tuple is a distinct count only.
        if (columns.Count > 1 && (agg != AGG_COUNT || !measure.Distinct()))
        {
            err($"@of lists {columns.Count} columns; a tuple is legal only with @agg: count and @distinct: true " +
                "(a distinct count of the tuple).");
            return false;
        }

        // M3 — @distinct is a count modifier.
        if (measure.Distinct() && agg is not null && agg != AGG_COUNT)
        {
            err($"@distinct: true requires @agg: count, not '{agg}'.");
            return false;
        }

        // M4 — the aggregate must be meaningful for the column's type.
        var single = fields.Count == 1 ? fields[0] : null;
        field = single;
        if (single is null || agg is null) return true;
        string first = columns[0];
        if ((agg == AGG_SUM || agg == AGG_AVG) && !ReportingNumericFieldSubtypes.Contains(single.SubType))
        {
            err($"@agg '{agg}' needs a numeric field (field.int, long, double, float, decimal or currency), " +
                $"but '{first}' is field.{single.SubType}.");
            return false;
        }
        if ((agg == AGG_MIN || agg == AGG_MAX) && ReportingUnorderedFieldSubtypes.Contains(single.SubType))
        {
            err($"@agg '{agg}' cannot order '{first}', a field.{single.SubType}.");
            return false;
        }
        return true;
    }

    /// <summary>M6 — each operand names a measure.aggregate of the same entity.</summary>
    private static void CheckRatioOperands(MemberCtx ctx, MetaMeasure ratio, Action<string> err)
    {
        (string Attr, string? Ref)[] operands =
        [
            (REPORTING_ATTR_NUMERATOR, ratio.Numerator()),
            (REPORTING_ATTR_DENOMINATOR, ratio.Denominator()),
        ];
        foreach (var (attr, @ref) in operands)
        {
            if (@ref is null) continue; // missing operand is ERR_MISSING_REQUIRED_ATTR
            var target = ReportingChildOfType(ctx.Host, TYPE_MEASURE, @ref);
            if (target is null)
            {
                err($"@{attr} '{@ref}' names no measure of '{ctx.Declaring.ResolutionKey()}'.");
            }
            else if (target.SubType != MEASURE_SUBTYPE_AGGREGATE)
            {
                err($"@{attr} '{@ref}' is a measure.{target.SubType}; a ratio's operands must be measure.aggregate " +
                    "(a ratio of ratios is not supported).");
            }
        }
    }

    // -------------------------------------------------------------------------
    // S1 / F2 — a reporting-host @filter over its entity
    // -------------------------------------------------------------------------

    /// <summary>
    /// Validate a canonical (post-desugar) attr.filter against <paramref name="entity"/>'s
    /// fields: every key names a field (S1), every op is legal for that field (S1), and a
    /// relative-date operand sits on a date/timestamp, under a range op, with a valid
    /// ISO-8601 duration (F2). One error per offending clause op.
    /// </summary>
    private static void CheckReportingFilter(
        IReadOnlyDictionary<string, object?> filter,
        MetaData entity,
        string entityKey,
        string hostLabel,
        MetaData host,
        string suffix,
        ReportingErrorSink sink)
    {
        void Err(string message) =>
            sink.Push(host, ErrorCode.ERR_BAD_ATTR_FILTER, hostLabel, $": {message}", suffix);

        foreach (var (key, clause) in filter)
        {
            if (key == FILTER_COMPOSE_OR || key == FILTER_COMPOSE_AND)
            {
                if (clause is not IReadOnlyList<object?> subs)
                {
                    Err($"@filter '{key}' must be an array of sub-clauses.");
                    continue;
                }
                foreach (var sub in subs)
                {
                    if (sub is IReadOnlyDictionary<string, object?> subFilter)
                    {
                        CheckReportingFilter(subFilter, entity, entityKey, hostLabel, host, suffix, sink);
                    }
                    else
                    {
                        Err($"@filter '{key}' contains a non-object sub-clause.");
                    }
                }
                continue;
            }
            var field = ReportingFieldOf(entity, key);
            if (field is null)
            {
                Err($"@filter names '{key}', which is not a field of '{entityKey}'.");
                continue;
            }
            if (clause is not IReadOnlyDictionary<string, object?> ops || ops.Count == 0)
            {
                Err($"@filter on '{key}' must be an {{ op: value }} object.");
                continue;
            }
            string[] allowed = OpsForField(field);
            foreach (var (op, operand) in ops)
            {
                if (!allowed.Contains(op))
                {
                    string allowedText = allowed.Length > 0 ? string.Join(", ", allowed) : "(none)";
                    Err($"@filter on '{key}' uses op '{op}', which is not allowed for field.{field.SubType}. " +
                        $"Allowed ops: {allowedText}.");
                    continue;
                }
                var relative = RelativeOperand(operand);
                if (relative is null) continue;
                if (!IsExactRelativeValue(relative))
                {
                    Err($"@filter on '{key}' has a malformed relative date {JsonStringify(relative)}; a relative date is " +
                        "exactly { now: \"<ISO-8601 duration>\" } with no other keys.");
                    continue;
                }
                if (!ReportingTemporalFieldSubtypes.Contains(field.SubType))
                {
                    Err($"@filter on '{key}' uses a relative date ({{ now: ... }}), but '{key}' is field.{field.SubType}; " +
                        "relative dates apply only to field.date and field.timestamp.");
                    continue;
                }
                if (!ReportingRelativeDateOps.Contains(op))
                {
                    Err($"@filter on '{key}' puts a relative date under op '{op}'; relative dates are legal only under " +
                        "gt, gte, lt and lte.");
                    continue;
                }
                var duration = relative[FILTER_RELATIVE_NOW];
                if (duration is not string d || !ISO_DURATION_RE.IsMatch(d))
                {
                    Err($"@filter on '{key}' has relative date '{QuoteValue(duration)}', which is not an ISO-8601 " +
                        "duration (e.g. '-P7D', '-PT12H').");
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // R1–R7 — object.report
    // -------------------------------------------------------------------------

    private static void CheckReport(MetaData root, MetaData report, ReportingErrorSink sink)
    {
        string label = $"report '{report.ResolutionKey()}'";
        void Err(string message, MetaData? node = null, ErrorCode code = ErrorCode.ERR_INVALID_REPORT) =>
            sink.Push(node ?? report, code, label, message);

        // R4 — a report's fields and identity are derived, never declared.
        // ADR-0039: own — the rule is about what the author declared on THIS report.
        foreach (var child in report.OwnChildren())
        {
            if (child.Type == TYPE_FIELD || child.Type == TYPE_IDENTITY)
            {
                Err($" declares {ReportingChildLabel(child)}; a report's fields and identity are derived " +
                    "from @dimensions and @measures, never declared.", child);
            }
        }

        // R5 — a report is read-only, so any source it has is read-only.
        // ADR-0039: resolving — an inherited source binds the report just the same.
        foreach (var source in report.Children().Where(c => c.Type == TYPE_SOURCE))
        {
            if (source is MetaSource ms && ms.IsWritable())
            {
                Err($": {ReportingChildLabel(source)} is writable; a report is read-only, so its source must " +
                    "declare a read-only @kind (view, materializedView, storedProc or tableFunction).", source);
            }
        }

        // R1 — @from resolves to an object.entity. Without it, R2/R3/R6/R7, R8/R9 and
        // the @filter have nothing to resolve against, so they are skipped.
        string? fromRef = ReportAccessors.ReportFrom(report);
        if (fromRef is null) return; // missing @from is ERR_MISSING_REQUIRED_ATTR
        var from = NamingRefs.ResolveObjectRef(root, fromRef, NamingRefs.EffectivePackage(report));
        if (from is null)
        {
            Err($": @from '{fromRef}' does not resolve to an object.");
            return;
        }
        if (from.Type != TYPE_OBJECT || from.SubType != OBJECT_SUBTYPE_ENTITY)
        {
            Err($": @from '{fromRef}' is an {from.Type}.{from.SubType}; a report aggregates the rows of an object.entity.");
            return;
        }
        string fromKey = from.ResolutionKey();

        // R6 — derived field name -> the item that derived it ("dimension item 'x'" / "measure 'y'").
        var derived = new Dictionary<string, string>(StringComparer.Ordinal);
        void Claim(string fieldName, string what)
        {
            if (derived.TryGetValue(fieldName, out var prior))
            {
                if (prior == what)
                {
                    // The same measure listed twice: name the repeat, not a "collision" with itself.
                    Err($": @measures lists '{fieldName}' more than once.");
                    return;
                }
                Err($": {prior} and {what} both derive report field '{fieldName}'. Report field names must be unique; " +
                    "rename the measure or drop one item.");
                return;
            }
            derived[fieldName] = what;
        }

        // R2 — each @dimensions item names a dimension of @from, with a grain exactly when it is a time dimension.
        var seenItems = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in ReportAccessors.ReportDimensionItems(report))
        {
            string raw = item.Grain is null ? item.Name : $"{item.Name}{REPORT_DIMENSION_GRAIN_SEPARATOR}{item.Grain}";
            if (!seenItems.Add(raw))
            {
                Err($": @dimensions lists '{raw}' more than once.");
                continue;
            }
            if (ReportingChildOfType(from, TYPE_DIMENSION, item.Name) is not MetaDimension dim)
            {
                Err($": @dimensions item '{raw}' names no dimension of @from '{fromKey}'.");
                continue;
            }
            if (dim.IsTime())
            {
                var grains = dim.Grains();
                if (item.Grain is null)
                {
                    Err($": @dimensions item '{raw}' names time dimension '{item.Name}' without a grain; write " +
                        $"'{item.Name}:<grain>' with a grain from its @grains ({string.Join(", ", grains)}).");
                    continue;
                }
                if (!grains.Contains(item.Grain))
                {
                    Err($": @dimensions item '{raw}' uses grain '{item.Grain}', which time dimension '{item.Name}' does not " +
                        $"declare. Its @grains: {string.Join(", ", grains)}.");
                    continue;
                }
            }
            else if (item.Grain is not null)
            {
                Err($": @dimensions item '{raw}' gives a grain to attribute dimension '{item.Name}'; only a time " +
                    "dimension takes a grain.");
                continue;
            }
            Claim(ReportAccessors.ReportDerivedFieldName(item), $"dimension item '{raw}'");
        }

        // R3 — each @measures item names a measure of @from.
        foreach (string item in ReportAccessors.ReportMeasureNames(report))
        {
            string? measureName = CheckReportMeasure(root, report, from, item, label, sink);
            if (measureName is not null) Claim(measureName, $"measure '{measureName}'");
        }

        // R7 — @segment names a segment of @from.
        // ADR-0039: resolving — a report may inherit @segment via extends.
        if (report.Attr(OBJECT_REPORT_ATTR_SEGMENT) is string segment &&
            ReportingChildOfType(from, TYPE_SEGMENT, segment) is null)
        {
            Err($": @segment '{segment}' names no segment of @from '{fromKey}'.");
        }

        // R8 — @spine is a to-one path from @from: rule D2's walk, started at @from.
        string? spine = ReportAccessors.ReportSpine(report);
        if (spine is not null)
        {
            var terminal = WalkToOneVia(root, from, spine, m => Err($": {m}"), SpineWalk(report, fromKey));
            // R9 — every listed dimension is reached through the spine. Skipped when R8 failed.
            if (terminal is not null)
            {
                string[] spineHops = ReportingSplitDotted(spine)?.Path ?? [];
                var items = ReportAccessors.ReportDimensionItems(report);
                if (items.Count == 0)
                {
                    Err($": @spine '{spine}' needs at least one dimension. The report's rows are the dimension tuples of " +
                        $"'{terminal.ResolutionKey()}'; with no dimension it would be one totals row.");
                }
                // One verdict per dimension, however many grains list it.
                var checkedDimensions = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in items)
                {
                    if (!checkedDimensions.Add(item.Name)) continue;
                    if (ReportingChildOfType(from, TYPE_DIMENSION, item.Name) is not MetaDimension dim) continue; // R2 already reported it
                    string? via = dim.Via();
                    if (via is null)
                    {
                        Err($": dimension '{item.Name}' is read from @from '{fromKey}', so it has no value in a row that has " +
                            $"no facts. With @spine '{spine}' every dimension must be reached through it: declare the " +
                            $"dimension over a field of '{terminal.ResolutionKey()}' (or an entity to-one from it) with an " +
                            $"@via that begins '{spine}'.");
                        continue;
                    }
                    // A @via that does not walk is D2's error, on the dimension; R9 does not report it again.
                    if (WalkToOneVia(root, from, via, _ => { }, D2Walk(dim.Parent ?? from)) is null) continue;
                    // Hop names are compared as written; the owner segment is not compared.
                    string[] hops = ReportingSplitDotted(via)?.Path ?? [];
                    if (hops.Length >= spineHops.Length &&
                        hops.Take(spineHops.Length).SequenceEqual(spineHops, StringComparer.Ordinal)) continue;
                    Err($": dimension '{item.Name}' is reached by @via '{via}', which does not begin with the hops of " +
                        $"@spine '{spine}'. Hop names are compared as written: if both name the same join, write the same " +
                        "hops; otherwise the dimension is not reached through the spine.");
                }
            }
        }

        // S1 / F2 — the report's row scope over @from.
        // ADR-0039: resolving — a report may inherit @filter via extends.
        if (AsPlainObject(report.Attr(OBJECT_REPORT_ATTR_FILTER)) is { } filter)
        {
            CheckReportingFilter(filter, from, fromKey, label, report, "", sink);
        }
    }

    /// <summary>
    /// R3 for one <c>@measures</c> item (bare <c>name</c> or dotted <c>Entity.name</c>).
    /// Returns the measure's name when it is a measure of @from (for R6), else reports
    /// ERR_REPORT_FOREIGN_MEASURE (it is another entity's measure) or ERR_INVALID_REPORT
    /// (it is nobody's) and returns null.
    /// </summary>
    private static string? CheckReportMeasure(
        MetaData root, MetaData report, MetaData from, string item, string label, ReportingErrorSink sink)
    {
        string fromKey = from.ResolutionKey();
        MetaData? owner;
        var parts = ReportingSplitDotted(item);
        if (parts is not null && parts.Value.Path.Length == 1)
        {
            owner = NamingRefs.ResolveObjectRef(root, parts.Value.Owner, NamingRefs.EffectivePackage(report));
            string name = parts.Value.Path[0];
            if (owner is not null && IsSelfOrAncestor(owner, from) &&
                ReportingChildOfType(from, TYPE_MEASURE, name) is not null)
            {
                return name;
            }
            if (owner is not null && ReportingChildOfType(owner, TYPE_MEASURE, name) is null) owner = null;
        }
        else if (!item.Contains(CHILD_REF_SEPARATOR, StringComparison.Ordinal))
        {
            string name = item;
            if (ReportingChildOfType(from, TYPE_MEASURE, name) is not null) return name;
            // ADR-0039: root has no super; Children()==OwnChildren() but resolving is the default.
            owner = root.Children().FirstOrDefault(o =>
                o.Type == TYPE_OBJECT &&
                o.SubType == OBJECT_SUBTYPE_ENTITY &&
                ReportingChildOfType(o, TYPE_MEASURE, name) is not null);
        }
        else
        {
            owner = null;
        }

        if (owner is not null)
        {
            string ownerKey = owner.ResolutionKey();
            string bare = item[(item.LastIndexOf(CHILD_REF_SEPARATOR, StringComparison.Ordinal) + 1)..];
            sink.Push(
                report,
                ErrorCode.ERR_REPORT_FOREIGN_MEASURE,
                label,
                $" lists measure '{bare}', which belongs to " +
                $"'{ownerKey}', not @from '{fromKey}'. All measures of a report come from @from; make a second " +
                $"report over '{ownerKey}'.");
        }
        else
        {
            sink.Push(
                report,
                ErrorCode.ERR_INVALID_REPORT,
                label,
                $": @measures item '{item}' names no measure of @from '{fromKey}' or of any other entity.");
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // F1 — relative-date values only on reporting hosts
    // -------------------------------------------------------------------------

    /// <summary>True for the hosts whose <c>@filter</c> may carry a relative-date value.</summary>
    private static bool IsReportingFilterHost(MetaData node) =>
        node.Type == TYPE_SEGMENT ||
        (node.Type == TYPE_MEASURE && node.SubType == MEASURE_SUBTYPE_AGGREGATE) ||
        (node.Type == TYPE_OBJECT && node.SubType == OBJECT_SUBTYPE_REPORT);

    /// <summary>
    /// F1 — walk the whole tree and refuse a <c>{ now: ... }</c> value in any attr.filter
    /// outside a reporting host (a projection @filter, a dataGrid preset, an
    /// origin.aggregate/first @filter): those hosts have no lowering for it.
    /// </summary>
    private static void CheckNoRelativeDates(MetaData node, TypeRegistry registry, ReportingErrorSink sink)
    {
        if (!IsReportingFilterHost(node))
        {
            // ADR-0039: own — only locally declared filters are lowered, and the walk
            // visits every declared node exactly once (an inherited filter is checked
            // where it is declared; origin.* never inherits, ADR-0029).
            foreach (var (attrName, value) in node.OwnAttrs())
            {
                bool isFilterAttr =
                    registry.FindAttrSchema(node.Type, node.SubType, attrName)?.ValueType == ATTR_SUBTYPE_FILTER;
                if (isFilterAttr && FilterContainsRelativeValue(value))
                {
                    sink.Push(
                        node,
                        ErrorCode.ERR_BAD_ATTR_FILTER,
                        ReportingNodeLabel(node),
                        $": @{attrName} uses a relative date ({{ now: ... }}), which is legal only in the " +
                        "@filter of a segment, measure.aggregate or object.report.");
                }
            }
        }
        // ADR-0039: own — a tree walk; each declared node is visited once, at its declaration.
        foreach (var child in node.OwnChildren()) CheckNoRelativeDates(child, registry, sink);
    }
}
