// Payload-type + render-handle codegen for prompt construction (FR-004 Plan #3, B).
//
// Emits the TYPED PAYLOAD as an idiomatic C# record (no runtime ValueObject; the
// render engine consumes the record's properties, and the record type gives the
// caller-side compile-time guarantee) plus a typed render handle. Property names
// are kept as the exact metadata field names so the render engine resolves
// `{{field}}` against the record.
//
// Ported from typescript/packages/codegen-ts/src/payload-codegen.ts. The
// assembler (RDB materialization + host overlay) is out of scope — this only
// emits the contract.
//
// ADR-0044 (#219) — collision-aware naming: record emission is a THREE-PASS
// pipeline, mirroring payload-codegen.ts:
//   1. CollectClosure    — walk the reference closure via the shared ADR-0042
//                           FQN-exact/package-local matcher (NamingRefs.ResolveObjectRef),
//                           collecting resolved VOs keyed by ResolutionKey() (never
//                           bare name — bare-keyed dedupe is the #219 defect: it
//                           silently drops the second same-short-name VO).
//   2. AssignEmittedNames — a PURE function of the closure: a bare short name
//                           unique in the closure emits bare; a collision emits
//                           EVERY member under its package-qualified derived
//                           name (PascalCase each package segment + short name).
//                           A still-colliding derived name fails loud
//                           (ERR_PAYLOAD_NAME_COLLISION).
//   3. EmitClosureRecords — emit each record + every reference through the name map.

using System.Text;
using MetaObjects.Meta;
using MetaObjects.Render;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen;

/// <summary>Emits typed payload records + render handles from view-object / template metadata.</summary>
public static class PayloadCodegen
{
    // ADR-0044 backstop error code — a codegen-time (not loader) error, peer of
    // MetaObjects.Render.Verify.ERR_VAR_NOT_ON_PAYLOAD. Declared LOCALLY rather than
    // added to the shared MetaObjects.ErrorCode enum / fixtures/conformance/ERROR-CODES.json
    // ledger: that ledger is checked for cross-port coverage (e.g. the Python
    // ErrorCode-enum-covers-corpus test), and registering it there before every port
    // implements the ADR-0044 fix would turn those OTHER ports' tests red. It moves
    // into the shared ledger once the Java/Kotlin/Python follow-up lands alongside this code.
    private const string ERR_PAYLOAD_NAME_COLLISION = "ERR_PAYLOAD_NAME_COLLISION";

    // Field subtype -> idiomatic C# scalar type. Mirrors the TS SCALAR map
    // (number split into int/long/double; dates are ISO strings on the wire).
    private static readonly IReadOnlyDictionary<string, string> ScalarType =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [FIELD_SUBTYPE_STRING]    = "string",
            [FIELD_SUBTYPE_INT]       = "int",
            [FIELD_SUBTYPE_LONG]      = "long",
            [FIELD_SUBTYPE_CURRENCY]  = "long",
            [FIELD_SUBTYPE_DOUBLE]    = "double",
            [FIELD_SUBTYPE_FLOAT]     = "double",
            [FIELD_SUBTYPE_DECIMAL]   = "double",
            [FIELD_SUBTYPE_BOOLEAN]   = "bool",
            [FIELD_SUBTYPE_DATE]      = "string",
            [FIELD_SUBTYPE_TIME]      = "string",
            [FIELD_SUBTYPE_TIMESTAMP] = "string",
        };

    // ADR-0039: resolve array-ness through the super chain (isArray is a native
    // property, not an attr; the former OwnAttr("isArray") clause was dead code).
    private static bool IsArrayField(MetaData field) => field.ResolvedIsArray();

    /// <summary>
    /// Resolve a payload-emission object reference: FQN-exact when qualified (ADR-0041/0042 —
    /// exact on <see cref="MetaData.ResolutionKey"/>, irrespective of <paramref name="referrerPkg"/>);
    /// package-local when bare (referrer's own package, else root-level) — falling back to a
    /// GLOBAL short-name scan (the pre-ADR-0044 record-emission convention: a C# record
    /// identifier is always bare, so record emission has always matched by bare short name
    /// regardless of package) when the package-local match fails. This keeps every existing
    /// implicit-package top-level <c>voName</c> call (no <paramref name="referrerPkg"/> supplied)
    /// resolving exactly as it did before this fix, while fixing the actual #219 defect: a
    /// FULLY-QUALIFIED nested ref now resolves EXACTLY (never the bare-scan fallback), so two
    /// same-short-name FQN refs in different packages resolve to their OWN distinct nodes
    /// instead of collapsing onto whichever one the old bare scan enumerated first. A
    /// well-formed cross-package BARE ref cannot reach the fallback in practice — ADR-0042
    /// requires every cross-package reference be authored FQN, so the loader itself already
    /// rejects a bare ref intended to cross a package boundary.
    /// </summary>
    private static MetaData? ResolveForEmission(MetaData root, string reference, string referrerPkg)
    {
        var resolved = global::MetaObjects.NamingRefs.ResolveObjectRef(root, reference, referrerPkg);
        if (resolved is not null) return resolved;
        if (reference.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal)) return null; // FQN already resolved exactly above
        return root.Children().FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == reference);
    }

    // -------------------------------------------------------------------------
    // ADR-0044 pass 1 — reference closure (FQN-exact / package-local resolution)
    // -------------------------------------------------------------------------

    /// <summary>
    /// ADR-0044 pass 1 — walk <paramref name="voRef"/>'s transitive <c>@objectRef</c>
    /// closure through the shared ADR-0042 matcher (<see cref="NamingRefs.ResolveObjectRef"/>),
    /// collecting resolved VOs keyed by <see cref="MetaData.ResolutionKey"/> (never bare
    /// name — the #219 defect). <paramref name="order"/>/<paramref name="byFqn"/> accumulate
    /// across multiple root calls so a batch emission shares ONE collision domain. A VO
    /// already visited is not re-walked (cycle/dedupe guard).
    /// </summary>
    private static void CollectClosure(
        MetaData root, string voRef, string referrerPkg,
        List<string> order, Dictionary<string, MetaData> byFqn)
    {
        var vo = ResolveForEmission(root, voRef, referrerPkg);
        if (vo is null) return;
        var fqn = vo.ResolutionKey();
        if (byFqn.ContainsKey(fqn)) return;
        byFqn[fqn] = vo;
        order.Add(fqn);
        // ADR-0042: a nested @objectRef resolves in the FIELD's OWN declaring package —
        // which may differ from this resolved VO's package when the field is inherited
        // via extends from an abstract VO in another package. Fall back to this VO's
        // package when a field has no parent (mirrors RenderHelperGenerator.DerivePayloadFieldTree).
        var voPkg = global::MetaObjects.NamingRefs.EffectivePackage(vo);
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            if (f.SubType != FIELD_SUBTYPE_OBJECT) continue;
            if (f.Attr(FIELD_ATTR_OBJECT_REF) is not string refAttr) continue;
            var fieldPkg = f.Parent is not null
                ? global::MetaObjects.NamingRefs.EffectivePackage(f.Parent)
                : voPkg;
            CollectClosure(root, refAttr, fieldPkg, order, byFqn);
        }
    }

    // -------------------------------------------------------------------------
    // ADR-0044 pass 2 — collision-aware naming
    // -------------------------------------------------------------------------

    private static string PascalSegment(string s) =>
        s.Length > 0 ? char.ToUpperInvariant(s[0]) + s[1..] : s;

    /// <summary>ADR-0044 — package-qualified derived name for a collision member: PascalCase
    /// each <c>::</c>-segment of the node's effective package, concatenated, then the bare
    /// short name (<c>acme::alpha::Note</c> -&gt; <c>AcmeAlphaNote</c>). A root-level
    /// (no-package) node has nothing to qualify with and keeps its bare name — two root-level
    /// VOs can never share a name (the loader's own-package uniqueness already rejects that).</summary>
    private static string PackageQualifiedName(string pkg, string shortName) =>
        pkg.Length == 0 ? shortName : string.Concat(pkg.Split(PACKAGE_SEPARATOR).Select(PascalSegment)) + shortName;

    /// <summary>
    /// ADR-0044 pass 2 — assign the emitted C# record name for every VO in the closure. A
    /// PURE function of the closure's (fqn, bareName, package) triples — never of traversal
    /// order: a bare short name unique in the closure emits bare; a collision emits EVERY
    /// member under its package-qualified derived name. If two DISTINCT fqns still derive the
    /// same name after qualification, throws (ERR_PAYLOAD_NAME_COLLISION) — never silently wrong.
    /// </summary>
    private static Dictionary<string, string> AssignEmittedNames(IReadOnlyDictionary<string, MetaData> byFqn)
    {
        var byShortName = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var (fqn, node) in byFqn)
        {
            if (!byShortName.TryGetValue(node.Name, out var bucket))
                byShortName[node.Name] = bucket = new List<string>();
            bucket.Add(fqn);
        }

        var nameMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (shortName, fqns) in byShortName)
        {
            if (fqns.Count == 1)
            {
                nameMap[fqns[0]] = shortName;
                continue;
            }
            foreach (var fqn in fqns)
            {
                var pkg = global::MetaObjects.NamingRefs.EffectivePackage(byFqn[fqn]);
                nameMap[fqn] = PackageQualifiedName(pkg, shortName);
            }
        }

        // Backstop — sorted by fqn so which pair the message names (and whether the set of
        // colliding names is non-empty) is a pure function of the closure, not of Dictionary
        // enumeration order.
        var ownerOf = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var fqn in nameMap.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var emitted = nameMap[fqn];
            if (ownerOf.TryGetValue(emitted, out var existing) && existing != fqn)
            {
                throw new InvalidOperationException(
                    $"{ERR_PAYLOAD_NAME_COLLISION}: payload record name collision: \"{emitted}\" derives from both \"{existing}\" and \"{fqn}\" — rename one value-object or move it to a package that derives a distinct name");
            }
            ownerOf[emitted] = fqn;
        }

        return nameMap;
    }

    /// <summary>
    /// ADR-0044 — compute the full reference closure + collision-aware emitted-name map for
    /// <paramref name="voRef"/>, for reuse by OTHER codegen tiers that must reference the SAME
    /// payload record names <see cref="GeneratePayloadRecords"/> would emit (the extract /
    /// output-parser tier — #228 — reuses this rather than re-deriving its own naming). Returns
    /// the traversal order (FQNs), the resolved-node-by-FQN map, and the emitted-name map (FQN
    /// -&gt; the bare-or-package-qualified C# identifier). A closure containing an unresolvable
    /// still-colliding derived name throws <c>ERR_PAYLOAD_NAME_COLLISION</c> (see <see cref="AssignEmittedNames"/>).
    /// </summary>
    internal static (List<string> Order, Dictionary<string, MetaData> ByFqn, Dictionary<string, string> NameMap)
        ComputeClosureAndNames(MetaData root, string voRef, string referrerPkg)
    {
        var order = new List<string>();
        var byFqn = new Dictionary<string, MetaData>(StringComparer.Ordinal);
        CollectClosure(root, voRef, referrerPkg, order, byFqn);
        var nameMap = AssignEmittedNames(byFqn);
        return (order, byFqn, nameMap);
    }

    /// <summary>The ADR-0044 emitted name for <paramref name="vo"/> from a closure name-map
    /// computed by <see cref="ComputeClosureAndNames"/> — falls back to the bare metadata name
    /// when <paramref name="vo"/> isn't a key in the map (defensive; a map from a closure walk
    /// that actually reached <paramref name="vo"/> always contains it).</summary>
    internal static string EmittedNameOf(MetaData vo, IReadOnlyDictionary<string, string> nameMap) =>
        nameMap.GetValueOrDefault(vo.ResolutionKey(), vo.Name);

    /// <summary>Resolve <paramref name="reference"/>'s emitted C# record name under the
    /// ADR-0044 naming rule, scoped to its OWN reference closure (the same closure
    /// <see cref="GeneratePayloadRecords"/> would emit). Returns null when <paramref name="reference"/>
    /// does not resolve to an object.value or sourceless object.projection (#210 — the loader
    /// enforces the legal template-level target set; nested targets stay value-only).</summary>
    internal static string? ResolveEmittedName(MetaData root, string reference, string referrerPkg)
    {
        var vo = ResolveForEmission(root, reference, referrerPkg);
        if (vo is null) return null;
        var (_, _, nameMap) = ComputeClosureAndNames(root, reference, referrerPkg);
        return nameMap.GetValueOrDefault(vo.ResolutionKey());
    }

    /// <summary>
    /// The nested C# enum type name for an enum-subtype payload field — the SAME scheme as
    /// <see cref="CSharpNaming.EnumTypeName"/> (the super name when the field <c>extends:</c> an
    /// abstract enum so all extenders share one type, else <c>&lt;OwnerPascal&gt;&lt;FieldPascal&gt;</c>).
    /// <paramref name="ownerName"/> is the ADR-0044 EMITTED (possibly package-qualified) record
    /// name — NOT the bare metadata name — so an enum field on a collision member never collides
    /// with the same-named field on its sibling (e.g. both alpha's and beta's Note declaring a
    /// `status` enum field would otherwise both derive "NoteStatus").
    /// </summary>
    public static string EnumTypeName(string ownerName, MetaData field)
    {
        if (field is MetaField mf && mf.ResolveSuper() is { } super)
            return Pascal(super.Name);
        return Pascal(ownerName) + Pascal(field.Name);
    }

    /// <summary>
    /// Collect nested <c>public enum &lt;Name&gt; { &lt;members&gt; }</c> declarations for the enum
    /// fields of <paramref name="vo"/>, deduped by type name (two fields extending one abstract enum
    /// emit ONE declaration). Mirrors EntityGenerator.CollectEnumDecls; members verbatim.
    /// </summary>
    private static List<string> CollectEnumDecls(MetaData vo, string voName)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var decls = new List<string>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD && c.SubType == FIELD_SUBTYPE_ENUM))
        {
            var values = f is MetaField mf ? mf.EffectiveEnumValues : null;
            if (values is null || values.Count == 0) continue;
            var typeName = EnumTypeName(voName, f);
            if (!seen.Add(typeName)) continue;   // dedup shared abstract-enum types
            decls.Add($"    public enum {typeName} {{ {string.Join(", ", values)} }}");
        }
        return decls;
    }

    // -------------------------------------------------------------------------
    // ADR-0044 pass 3 — emit records through the name map
    // -------------------------------------------------------------------------

    private static void EmitClosureRecords(
        MetaData root, List<string> order, Dictionary<string, MetaData> byFqn,
        Dictionary<string, string> nameMap, List<string> output)
    {
        foreach (var fqn in order)
        {
            var vo = byFqn[fqn];
            var voName = nameMap[fqn];
            var voPkg = global::MetaObjects.NamingRefs.EffectivePackage(vo);

            var lines = new List<string> { $"public sealed record {voName}", "{" };
            // Nested enum declarations first — C# requires an enum type be declared before a
            // property references it (deduped so shared abstract-enum extenders emit one decl).
            lines.AddRange(CollectEnumDecls(vo, voName));
            // Use Children() (effective) so inherited projection fields are included.
            foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
            {
                string type;
                if (f.SubType == FIELD_SUBTYPE_OBJECT)
                {
                    // ADR-0039: resolving — @objectRef may be inherited via extends.
                    var refAttr = f.Attr(FIELD_ATTR_OBJECT_REF) as string;
                    if (refAttr is not null)
                    {
                        // The nested ref resolves in the FIELD's declaring package (ADR-0042),
                        // not the resolved VO's — they differ when `f` is inherited from an
                        // abstract VO elsewhere.
                        var fieldPkg = f.Parent is not null
                            ? global::MetaObjects.NamingRefs.EffectivePackage(f.Parent)
                            : voPkg;
                        var refNode = ResolveForEmission(root, refAttr, fieldPkg);
                        // refNode was walked into the closure by CollectClosure — the name map
                        // always has it. The StripPkg fallback only guards a defensive gap (e.g. a
                        // caller-constructed closure that skipped pass 1).
                        var refName = refNode is not null && nameMap.TryGetValue(refNode.ResolutionKey(), out var mapped)
                            ? mapped
                            : CSharpNaming.StripPkg(refAttr);
                        type = IsArrayField(f) ? $"IReadOnlyList<{refName}>" : refName;
                    }
                    else
                    {
                        type = "object";
                    }
                }
                else if (f.SubType == FIELD_SUBTYPE_ENUM)
                {
                    // Enum payload field -> the generated nested C# enum type (same scheme entity
                    // codegen uses via CSharpNaming.EnumTypeName), NOT the `object` fallback.
                    string enumType = EnumTypeName(voName, f);
                    type = IsArrayField(f) ? $"IReadOnlyList<{enumType}>" : enumType;
                }
                else
                {
                    var scalar = ScalarType.GetValueOrDefault(f.SubType, "object");
                    // Scalar array (e.g. field.string with isArray) -> a list of the scalar.
                    type = IsArrayField(f) ? $"IReadOnlyList<{scalar}>" : scalar;
                }
                lines.Add($"    public required {type} {f.Name} {{ get; init; }}");
            }
            lines.Add("}");
            output.Add(string.Join("\n", lines));
        }
    }

    /// <summary>
    /// Emit the payload record (+ nested element records) for a payload shape — an
    /// object.value or sourceless object.projection (#210; the loader owns the target-set
    /// constraint, this emitter is subtype-blind).
    /// <paramref name="referrerPkg"/> (ADR-0042) is the package a bare <paramref name="voName"/>
    /// resolves in; pass an FQN and it is ignored. ADR-0044: a short-name collision within
    /// <paramref name="voName"/>'s reference closure emits EVERY colliding member under its
    /// package-qualified derived name; a non-colliding closure emits byte-identical bare names
    /// (unchanged from pre-ADR-0044 output).
    /// </summary>
    public static string GeneratePayloadRecords(MetaData root, string voName, string referrerPkg = "")
    {
        var (order, byFqn, nameMap) = ComputeClosureAndNames(root, voName, referrerPkg);
        var output = new List<string>();
        EmitClosureRecords(root, order, byFqn, nameMap, output);
        return string.Join("\n\n", output) + "\n";
    }

    /// <summary>
    /// Derive the verify field tree (the input to <c>Verify.Check</c>) from an
    /// object.value view-object: scalars become leaves, object-ref fields recurse
    /// into nested element trees. This is the metadata→verify bridge a `dotnet meta verify`
    /// command uses to drift-check a template against its @payloadRef. <paramref name="referrerPkg"/>
    /// (ADR-0042, #228) is the declaring template's effective package — a bare <paramref name="voName"/>
    /// resolves there FIRST (else root-level, else the pre-ADR-0044 global bare-name scan — the
    /// SAME fallback record emission uses, see <see cref="ResolveForEmission"/>), so a template
    /// whose bare <c>@payloadRef</c> collides with a same-short-named object.value in ANOTHER
    /// package binds its OWN package's object — never whichever one loads first.
    /// </summary>
    public static IReadOnlyList<PayloadField> BuildPayloadFieldTree(MetaData root, string voName, string referrerPkg = "") =>
        BuildTree(root, voName, referrerPkg, new HashSet<string>(StringComparer.Ordinal));

    private static IReadOnlyList<PayloadField> BuildTree(MetaData root, string voName, string referrerPkg, HashSet<string> visiting)
    {
        // Shares the record-emission resolver (ADR-0042/0044): FQN-exact when qualified, else
        // referrer-package-local, else the pre-ADR-0044 global bare-name-scan fallback.
        var vo = ResolveForEmission(root, voName, referrerPkg);
        // ADR-0039: dedupe/cycle-guard by ResolutionKey (FQN), never the bare ref string — two
        // DIFFERENT same-short-named nodes reached via different bare refs must not collapse
        // onto "already visiting" (the #219-class dedupe defect).
        if (vo is null || !visiting.Add(vo.ResolutionKey())) return [];
        var voPkg = global::MetaObjects.NamingRefs.EffectivePackage(vo);
        var fields = new List<PayloadField>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            // ADR-0039: resolving — @objectRef may be inherited via extends (TS reads f.attr).
            if (f.SubType == FIELD_SUBTYPE_OBJECT && f.Attr(FIELD_ATTR_OBJECT_REF) is string refName)
            {
                // ADR-0042: a nested @objectRef resolves in the FIELD's OWN declaring package,
                // which may differ from this VO's when the field is inherited via extends from
                // an abstract VO in another package (mirrors CollectClosure's fieldPkg).
                var fieldPkg = f.Parent is not null
                    ? global::MetaObjects.NamingRefs.EffectivePackage(f.Parent)
                    : voPkg;
                fields.Add(new PayloadField(f.Name, BuildTree(root, refName, fieldPkg, visiting)));
            }
            else
                fields.Add(new PayloadField(f.Name));
        }
        visiting.Remove(vo.ResolutionKey());
        return fields;
    }

    private static string Pascal(string s) =>
        s.Length > 0 ? char.ToUpperInvariant(s[0]) + s[1..] : s;

    /// <summary>
    /// Emit a typed render handle binding a template's @textRef + @format and typing
    /// its payload to the @payloadRef record. The generated code's only MetaObjects
    /// dependency is MetaObjects.Render (framework philosophy: generated code is
    /// idiomatic and runtime-light).
    /// </summary>
    public static string GenerateRenderHandle(MetaData root, string templateName)
    {
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        var tmpl = root.Children()
            .FirstOrDefault(c => c.Type == TYPE_TEMPLATE && c.Name == templateName)
            ?? throw new ArgumentException($"template \"{templateName}\" not found", nameof(templateName));

        // ADR-0039: resolving — template refs may be inherited via an abstract template base.
        var payloadRef = tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) as string
            ?? throw new InvalidOperationException($"template \"{templateName}\" has no @payloadRef");
        // ADR-0044: the parameter TYPE is the resolved root VO's ADR-0044 emitted name (bare
        // when unique in its closure, package-qualified on a short-name collision) — NOT the
        // raw (possibly FQN) payloadRef, which is not a valid C# type name when qualified.
        var payloadType = ResolveEmittedName(root, payloadRef, "") ?? CSharpNaming.StripPkg(payloadRef);
        var textRef = tmpl.Attr(TEMPLATE_ATTR_TEXT_REF) as string ?? "";
        var format = tmpl.Attr(TEMPLATE_ATTR_FORMAT) as string ?? "text";
        var fn = $"Render{Pascal(templateName)}";

        var sb = new StringBuilder();
        sb.AppendLine("using MetaObjects.Render;");
        sb.AppendLine();
        sb.AppendLine("public static class RenderHandles");
        sb.AppendLine("{");
        sb.AppendLine($"    public static string {fn}({payloadType} payload, IProvider provider) =>");
        sb.AppendLine("        Renderer.Render(new RenderRequest");
        sb.AppendLine("        {");
        sb.AppendLine($"            Ref = {Quote(textRef)},");
        sb.AppendLine("            Payload = payload,");
        sb.AppendLine($"            Format = {Quote(format)},");
        sb.AppendLine("            Provider = provider,");
        sb.AppendLine("        });");
        sb.AppendLine("}");
        return sb.ToString();
    }

    private static string Quote(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}
