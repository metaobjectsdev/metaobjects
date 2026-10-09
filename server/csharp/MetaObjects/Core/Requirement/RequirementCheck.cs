// RequirementCheck — the requirement (capability) gate `dotnet meta verify` runs.
//
// Requirements are METADATA: `requirement.functional` / `requirement.architectural` are
// registered metamodel types. So this file parses NOTHING. It reads `requirement.*` nodes
// off the already-loaded model and checks the things the loader cannot (ADR-0057).
//
// Division of labour:
//
//   LOADER (unconditional)   the `@status` enum, required attrs, child rules, levels
//                            being integers.
//   VERIFY  (conditional)    `@implementedBy` resolution, whose SEVERITY DEPENDS ON
//                            `@status`: a `planned` requirement names nodes that do not
//                            exist YET, so a loader reference descriptor, which always
//                            errors, would make every recorded intention fail to load.
//
// Ported 1:1 from the TypeScript reference, server/typescript/packages/cli/src/lib/
// requirement-check.ts. The codes, their conditions, their ORDER and their message text are
// copied from it, and fixtures/requirement-check-conformance/ holds this port to it.
//
// What a clean run proves is referential integrity. It never proves that a status is true,
// or that a claimed node implements the requirement claiming it.

using System.Globalization;
using MetaObjects.Library;
using MetaObjects.Meta;

namespace MetaObjects.Core.Requirement;

/// <summary>One finding of the requirement gate.</summary>
/// <param name="Severity"><c>error</c> or <c>warn</c>.</param>
/// <param name="Code">The diagnostic code.</param>
/// <param name="Path">
/// The subject's ADDRESS, the dotted chain of requirement names with no package. Two branches of
/// a ledger may reuse a NAME, so a bare name does not locate the node. Null when the subject is
/// an entity (object coverage names the entity in its message instead).
/// </param>
/// <param name="Message">The message text.</param>
public sealed record RequirementDiagnostic(string Severity, string Code, string? Path, string Message);

/// <summary>A requirement paired with its ADDRESS: the dotted chain of requirement names from the root.</summary>
public sealed record AddressedRequirement(MetaRequirement Node, string Path);

/// <summary>
/// What one run computes once and both the gate and the summary read, so the printed summary
/// cannot disagree with the diagnostics beneath it.
/// </summary>
public sealed record RequirementScan(
    IReadOnlyList<AddressedRequirement> Addressed,
    IReadOnlySet<string> ClaimedObjects,
    bool MeasureCoverage,
    bool RequireImplementers);

/// <summary>
/// Counts behind the summary line printed on every run, clean or not. <c>EntitiesTotal</c> and
/// <c>EntitiesClaimed</c> are null when coverage was not measured: absence is the honest reading
/// of "this project authored no requirement of its own, so it asked to be held to none".
/// </summary>
public sealed record RequirementSummary(
    int Total,
    int Functional,
    int Architectural,
    IReadOnlyDictionary<string, int> ByStatus,
    int Undecided,
    int DeferredUntracked,
    int? EntitiesClaimed,
    int? EntitiesTotal);

/// <summary>The requirement gate: the walk, the scan, the checks and the summary.</summary>
public static class RequirementCheck
{
    public const string SeverityError = "error";
    public const string SeverityWarn = "warn";

    public const string ERR_REQUIREMENT_LINK_ABOVE_FLOOR = "ERR_REQUIREMENT_LINK_ABOVE_FLOOR";
    public const string ERR_REQUIREMENT_DANGLING_REF = "ERR_REQUIREMENT_DANGLING_REF";
    public const string ERR_REQUIREMENT_BAD_LEVEL = "ERR_REQUIREMENT_BAD_LEVEL";
    public const string ERR_REQUIREMENT_LEVEL_NESTING = "ERR_REQUIREMENT_LEVEL_NESTING";
    public const string ERR_REQUIREMENT_L4_NOT_OBJECT = "ERR_REQUIREMENT_L4_NOT_OBJECT";
    public const string ERR_REQUIREMENT_L5_NOT_MEMBER = "ERR_REQUIREMENT_L5_NOT_MEMBER";
    public const string ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS = "ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS";
    public const string WARN_REQUIREMENT_OBJECT_UNCLAIMED = "WARN_REQUIREMENT_OBJECT_UNCLAIMED";
    public const string WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE = "WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE";
    public const string WARN_REQUIREMENT_DEFERRED_UNTRACKED = "WARN_REQUIREMENT_DEFERRED_UNTRACKED";
    public const string WARN_REQUIREMENT_NOTHING_IMPLEMENTS = "WARN_REQUIREMENT_NOTHING_IMPLEMENTS";

    /// <summary>
    /// Severity of the object-coverage gate. It stays a warning: on a real estate carrying a
    /// single requirement it reports every entity, and at error a project adopting requirements
    /// incrementally would fail its first <c>verify</c> after authoring one entry.
    /// </summary>
    public const string OBJECT_COVERAGE_SEVERITY = SeverityWarn;

    // -- the walk and the address -----------------------------------------------------------

    /// <summary>
    /// Every <c>requirement.*</c> node in the tree, at any nesting depth, each with its dotted
    /// path. Hierarchy IS nesting, so this is a walk. It descends through EVERY node, not only
    /// through requirements: a requirement somewhere the child rules did not anticipate is
    /// still gated, which is the fail-closed direction for a gate. Only a requirement
    /// contributes a path segment.
    /// </summary>
    public static IReadOnlyList<AddressedRequirement> CollectAddressed(MetaData root)
    {
        var output = new List<AddressedRequirement>();
        Walk(root, "", output);
        return output;
    }

    private static void Walk(MetaData node, string prefix, List<AddressedRequirement> output)
    {
        foreach (var c in node.Children())
        {
            // Only a requirement contributes a path segment; an intervening non-requirement
            // node is walked THROUGH, so the address stays the requirement hierarchy.
            var isReq = c.Type == TYPE_REQUIREMENT;
            var path = isReq ? (prefix.Length == 0 ? c.Name : $"{prefix}.{c.Name}") : prefix;
            if (isReq) output.Add(new AddressedRequirement((MetaRequirement)c, path));
            Walk(c, path, output);
        }
    }

    /// <summary>
    /// The package a requirement resolves references in. The node's own declared package, else
    /// that of the nearest enclosing node that declares one, else the file's default package,
    /// else <c>""</c>.
    /// </summary>
    /// <remarks>
    /// Read through <see cref="NamingRefs.EffectivePackage"/>, which cuts the node's
    /// <see cref="MetaData.ResolutionKey"/>: its own package, else its file-default package, else the
    /// package of the nearest ancestor that declares one. That is Table A's wording, and it is what
    /// the Java port does. It agrees with TypeScript on every shape the corpus pins (a nested
    /// requirement takes its parent's package, not the file's, because the C# parser hands each
    /// child the nearest declaring node's package as its file-default) and on a package-less
    /// document loaded after a packaged one (both parsers fall back to the accumulating root's
    /// package). It differs in one known shape: a child merged into a package-declaring node from a
    /// package-less document. C# takes the declaring ancestor's package; TypeScript takes none.
    /// That is a loader-level difference outside the gate, recorded for the owner.
    /// </remarks>
    public static string EffectivePackage(MetaData node) => NamingRefs.EffectivePackage(node);

    // -- the scan ---------------------------------------------------------------------------

    /// <summary>
    /// Walk the model once and resolve every claim once.
    /// </summary>
    /// <param name="measureCoverage">
    /// Force coverage on or off instead of deriving it from who authored the requirements.
    /// Null derives it (see <see cref="ProjectAuthoredRequirements"/>).
    /// </param>
    /// <param name="requireImplementers">
    /// The strict switch: raise <see cref="WARN_REQUIREMENT_NOTHING_IMPLEMENTS"/> to an error.
    /// </param>
    public static RequirementScan Scan(MetaData root, bool? measureCoverage = null, bool requireImplementers = false)
    {
        var addressed = CollectAddressed(root);
        return new RequirementScan(
            addressed,
            ClaimedObjectKeys(root, addressed.Select(a => a.Node)),
            measureCoverage ?? ProjectAuthoredRequirements(addressed),
            requireImplementers);
    }

    /// <summary>
    /// Did the ADOPTER author any of these requirements? A library ships its own ledger, and
    /// without this, opting into a library would switch the unclaimed-entity gate on across a
    /// project that has never written a requirement. Provenance is the library's declared
    /// PACKAGE, a manifest fact. An overlay on a library requirement stays in the library's
    /// package and does not activate coverage.
    /// </summary>
    private static bool ProjectAuthoredRequirements(IReadOnlyList<AddressedRequirement> addressed)
    {
        var libraryPackages = LibrarySources.LibraryPackages();
        return addressed.Any(a => !libraryPackages.Contains(EffectivePackage(a.Node)));
    }

    /// <summary>
    /// Resolution keys of every object claimed by a requirement. Shared by the gate and the
    /// summary. A PLANNED requirement never contributes, so declaring an intention cannot clear
    /// an unclaimed-entity warning. An ARCHITECTURAL claim also covers every root-level object
    /// whose resolved super chain reaches the owner; a functional claim does not.
    /// </summary>
    private static HashSet<string> ClaimedObjectKeys(MetaData root, IEnumerable<MetaRequirement> requirements)
    {
        var claimed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var req in requirements)
        {
            if (req.IsPlanned()) continue;
            var referrerPkg = EffectivePackage(req);
            foreach (var reference in req.ImplementedBy)
            {
                var split = RequirementClaims.SplitMemberRef(reference);
                var node = RequirementClaims.ResolveClaimTarget(root, split.Owner, referrerPkg);
                if (node is null) continue;
                if (split.Path.Count > 0 && RequirementClaims.ResolveMember(node, split.Path) is null) continue;
                claimed.Add(node.ResolutionKey());
                // ARCHITECTURAL claims propagate DOWN the extends chain; functional ones do not.
                // A policy claimed on an abstract base genuinely holds for everything extending
                // it. A functional claim says an entity exists for a REASON, and inheriting a
                // reason from a shared base would mean adding an entity no longer forces anyone
                // to say what it is for.
                if (req.IsArchitectural())
                {
                    foreach (var sub in SubtypesOf(root, node)) claimed.Add(sub);
                }
            }
        }
        return claimed;
    }

    /// <summary>
    /// Resolution keys of every root-level object whose RESOLVED super chain reaches
    /// <paramref name="ancestor"/>. Walks the resolved super pointer, never the raw
    /// <c>extends</c> string, so a cross-package reference resolves the way the loader resolved
    /// it.
    /// </summary>
    private static List<string> SubtypesOf(MetaData root, MetaData ancestor)
    {
        var output = new List<string>();
        foreach (var cand in root.Children())
        {
            if (cand.Type != TYPE_OBJECT || ReferenceEquals(cand, ancestor)) continue;
            var seen = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
            var cur = cand.SuperData;
            while (cur is not null && seen.Add(cur))
            {
                if (ReferenceEquals(cur, ancestor))
                {
                    output.Add(cand.ResolutionKey());
                    break;
                }
                cur = cur.SuperData;
            }
        }
        return output;
    }

    /// <summary>
    /// The entities object coverage measures: root-level, non-abstract <c>object.entity</c>.
    /// <c>object.value</c> and <c>object.projection</c> are exempt: a value is a shape, and a
    /// projection is derived from an entity that is itself claimable. An abstract entity is
    /// shape, not data.
    /// </summary>
    private static List<MetaData> CoverableEntities(MetaData root) =>
        // ADR-0039 sanctioned own-only read: abstractness describes THIS declaration and is
        // never inherited, so IsAbstract is read as the node's own flag.
        root.Children()
            .Where(n => n.Type == TYPE_OBJECT && n.SubType == OBJECT_SUBTYPE_ENTITY && !n.IsAbstract)
            .ToList();

    /// <summary>
    /// True when this requirement, or anything nested beneath it, names an implementing node.
    /// Subtree-scoped deliberately: an L1 solution that delegates everything to its children
    /// implements nothing directly, and flagging that would fire on the correct shape of every
    /// tree.
    /// </summary>
    private static bool SubtreeClaimsAnything(MetaRequirement req)
    {
        if (req.ImplementedBy.Count > 0) return true;
        foreach (var child in req.Children())
        {
            if (child.Type != TYPE_REQUIREMENT) continue;
            if (SubtreeClaimsAnything((MetaRequirement)child)) return true;
        }
        return false;
    }

    // -- the ledger -------------------------------------------------------------------------

    /// <summary>
    /// Resolve a <c>@supersededBy</c> reference to a requirement in the same ledger (FR-039).
    ///
    /// <para>Resolves against the LEDGER, not the model: a capability is replaced by another
    /// capability. Pointing this at an entity would be <c>@implementedBy</c> wearing a
    /// different name, and <c>@implementedBy</c> is exactly what a retired entry may not have.
    /// A bare path is looked up across every package, and the first requirement in walk order
    /// wins.</para>
    /// </summary>
    public static MetaRequirement? ResolveRequirementRef(
        IReadOnlyList<AddressedRequirement> addressed, string reference, string referrerPkg)
    {
        var keyed = new Dictionary<string, MetaRequirement>(StringComparer.Ordinal);
        foreach (var (node, path) in addressed)
        {
            var pkg = EffectivePackage(node);
            if (pkg.Length > 0) keyed[$"{pkg}{PACKAGE_SEPARATOR}{path}"] = node;
            // The bare path is registered too, so a single-package ledger can reference without
            // repeating its own package on every line.
            keyed.TryAdd(path, node);
        }
        // An FQN binds exactly; a bare ref prefers the referrer's own package.
        if (keyed.TryGetValue(reference, out var exact)) return exact;
        if (referrerPkg.Length > 0 && keyed.TryGetValue($"{referrerPkg}{PACKAGE_SEPARATOR}{reference}", out var local))
            return local;
        return null;
    }

    // -- the gate ---------------------------------------------------------------------------

    /// <summary>
    /// Check the requirement tree against the loaded model. No requirements: no diagnostics.
    /// Rows are evaluated per requirement in the order of the reference's code table; object
    /// coverage runs once, after every requirement.
    /// </summary>
    public static IReadOnlyList<RequirementDiagnostic> Check(MetaData root, RequirementScan scan)
    {
        var output = new List<RequirementDiagnostic>();
        if (scan.Addressed.Count == 0) return output; // opt-in by declaration

        foreach (var (req, reqPath) in scan.Addressed)
        {
            var architectural = req.IsArchitectural();
            // The number as authored: an integer beyond `int` must be reported as itself, not wrapped.
            var level = req.RawLevel;
            var refs = req.ImplementedBy;

            // -- the level rules ------------------------------------------------------------
            // A functional requirement MUST be levelled. An architectural one MAY be, and
            // levelling is the OPT-IN: unlevelled it is a flat policy these rules must not touch.
            var levelled = level is not null;
            if (!architectural || levelled)
            {
                if (level is null || level < REQUIREMENT_MIN_LEVEL || level > REQUIREMENT_MAX_LEVEL)
                {
                    output.Add(Error(ERR_REQUIREMENT_BAD_LEVEL, reqPath, Invariant(
                        $"level must be an integer {REQUIREMENT_MIN_LEVEL}-{REQUIREMENT_MAX_LEVEL} (got {Show(level)}). ") +
                        "L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member." +
                        (architectural
                            ? " On an architectural requirement the level is optional — omit it for a flat policy."
                            : "")));
                }
                // Nesting IS the hierarchy, so a child must sit strictly below its parent.
                if (req.Parent is { Type: TYPE_REQUIREMENT } parent)
                {
                    var parentLevel = ((MetaRequirement)parent).RawLevel;
                    if (parentLevel is not null && level is not null && level <= parentLevel)
                    {
                        output.Add(Error(ERR_REQUIREMENT_LEVEL_NESTING, reqPath, Invariant(
                            $"nested under \"{parent.Name}\" (level {parentLevel}) but declares level {level}. ") +
                            "Nesting is the hierarchy — a child sits strictly below its parent."));
                    }
                }
            }

            // -- the link boundary ----------------------------------------------------------
            if (refs.Count > 0 && !req.MayReferenceModel())
            {
                output.Add(Error(ERR_REQUIREMENT_LINK_ABOVE_FLOOR, reqPath,
                    $"'implementedBy' is legal at L{REQUIREMENT_LINK_FLOOR_LEVEL} (object) and " +
                    $"L{REQUIREMENT_MAX_LEVEL} (member) only. L1-L3 are organisational and never reference " +
                    $"the model — move the links to a nested L{REQUIREMENT_LINK_FLOOR_LEVEL} child."));
                continue;
            }

            var referrerPkg = EffectivePackage(req);
            foreach (var reference in refs)
            {
                var split = RequirementClaims.SplitMemberRef(reference);
                var node = RequirementClaims.ResolveClaimTarget(root, split.Owner, referrerPkg);
                var isObjectRef = split.Path.Count == 0;

                // GRAIN stays functional-only DELIBERATELY. On a functional requirement L4 and
                // L5 MEAN "an object" and "a member". On a levelled architectural one the upper
                // tiers are a quality taxonomy and L4/L5 retain only their link-floor meaning,
                // so a policy whose claim set legitimately mixes grains must not be forced to
                // split by grain to say so.
                if (!architectural && level == REQUIREMENT_LINK_FLOOR_LEVEL && !isObjectRef)
                {
                    output.Add(Error(ERR_REQUIREMENT_L4_NOT_OBJECT, reqPath,
                        $"L{REQUIREMENT_LINK_FLOOR_LEVEL} references an object; '{reference}' names a member. " +
                        $"Move it to a nested L{REQUIREMENT_LEVEL_MEMBER} child, or reference the object itself."));
                    continue;
                }
                if (!architectural && level == REQUIREMENT_LEVEL_MEMBER && isObjectRef)
                {
                    output.Add(Error(ERR_REQUIREMENT_L5_NOT_MEMBER, reqPath,
                        $"L{REQUIREMENT_LEVEL_MEMBER} references a member (field, view or identity); " +
                        $"'{reference}' names an object. Move it to its L{REQUIREMENT_LINK_FLOOR_LEVEL} parent."));
                    continue;
                }

                var resolved = node is not null
                    && (isObjectRef || RequirementClaims.ResolveMember(node, split.Path) is not null);
                // Severity is CONDITIONAL ON STATUS. On `planned` the nodes do not exist YET:
                // that is the entry doing its job, and the reason this check cannot live in the
                // loader.
                if (!resolved && req.RequiresLiveNodes())
                {
                    // The did-you-mean hint answers an OBJECT that failed to resolve. When the
                    // object resolved and only the member is gone, name the member instead.
                    // The hint builder is given the OWNER alone: it cuts a reference at the first
                    // `.` of the whole string, which is right only once the reference is split.
                    var hint = node is null
                        ? NamingRefs.DidYouMeanHint(root, split.Owner)
                        : MissingMemberHint(node, split.Path);
                    output.Add(Error(ERR_REQUIREMENT_DANGLING_REF, reqPath,
                        $"'{reference}' does not resolve in the loaded model (status '{Show(req.Status)}' — " +
                        "the model moved and the requirement is stale)." + hint));
                }
            }

            // -- @supersededBy resolution (FR-039) ------------------------------------------
            // Resolution is what makes a supersession CHAIN survive: a prose note points one
            // hop and rots when that hop is itself retired, while a resolved reference does not.
            var superseded = req.SupersededBy;
            if (superseded is not null
                && ResolveRequirementRef(scan.Addressed, superseded, referrerPkg) is null)
            {
                output.Add(Error(ERR_REQUIREMENT_DANGLING_REF, reqPath,
                    $"@supersededBy '{superseded}' does not name a requirement in the loaded " +
                    "ledger. It must name the requirement that REPLACED this one — if nothing did, " +
                    "drop the attribute and let `notes` carry why the capability went."));
            }

            // -- architectural universality, v1: claim-set arithmetic -----------------------
            // A live policy claimed by nothing is declared and applied to nothing. Two
            // exemptions, both structural: `planned` is SUPPOSED to be applied to nothing yet,
            // and an ORGANISATIONAL node of a levelled architectural tree names nothing, exactly
            // as an L1 functional node does (MayReferenceModel encodes "is this tier allowed to
            // name the model at all").
            var status = req.Status;
            var live = req.RequiresLiveNodes();
            if (architectural && live && refs.Count == 0 && req.MayReferenceModel())
            {
                output.Add(Error(ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS, reqPath,
                    $"architectural requirement is '{Show(status)}' but nothing implements it. " +
                    "Its check is universality — a claim set of zero means the policy is declared and unapplied."));
            }

            // -- disposition: the decision, not the state -----------------------------------
            var disposition = req.Disposition;
            if (disposition is not null && !req.HasOutstandingWork())
            {
                output.Add(Warn(WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE, reqPath,
                    $"carries @disposition '{disposition}' but its status is '{Show(status)}', which has no " +
                    "outstanding work to decide about. A disposition is meaningful on 'planned' and 'partial' only — " +
                    "on any other status the decision IS the status."));
            }

            // -- functional existence, SUBTREE-scoped ---------------------------------------
            // The strict switch raises the SEVERITY only. The code keeps its WARN_ name on
            // purpose: it identifies the finding, and one finding under two codes would split
            // every suppression and corpus case that keys on it.
            if (!architectural && live && !SubtreeClaimsAnything(req))
            {
                output.Add(new RequirementDiagnostic(
                    scan.RequireImplementers ? SeverityError : SeverityWarn,
                    WARN_REQUIREMENT_NOTHING_IMPLEMENTS, reqPath,
                    $"is '{Show(status)}' but neither it nor anything nested under it names an " +
                    "implementing node. A functional requirement's check is existence — a subtree that claims " +
                    "nothing is a capability nobody built."));
            }

            if (disposition == REQUIREMENT_DISPOSITION_DEFERRED && req.TrackedBy.Count == 0)
            {
                output.Add(Warn(WARN_REQUIREMENT_DEFERRED_UNTRACKED, reqPath,
                    "is deferred but names no @trackedBy issue. Deferring without a ticket is how a known gap " +
                    "becomes an unknown one — nothing will raise it again."));
            }
        }

        // -- object coverage: adding an entity forces a requirement --------------------------
        // Binary per entity, never a ratio. Entities only, object grain only, and ADOPTER-
        // AUTHORED requirements only: a library's ledger is counted and checked, but it cannot
        // volunteer you for coverage.
        if (scan.MeasureCoverage)
        {
            foreach (var ent in CoverableEntities(root))
            {
                var key = ent.ResolutionKey();
                if (scan.ClaimedObjects.Contains(key)) continue;
                output.Add(new RequirementDiagnostic(
                    OBJECT_COVERAGE_SEVERITY, WARN_REQUIREMENT_OBJECT_UNCLAIMED, null,
                    $"no requirement claims '{key}'. Add it to an L{REQUIREMENT_LINK_FLOOR_LEVEL} requirement's 'implementedBy'."));
            }
        }

        return output;
    }

    private static RequirementDiagnostic Error(string code, string path, string message) =>
        new(SeverityError, code, path, message);

    private static RequirementDiagnostic Warn(string code, string path, string message) =>
        new(SeverityWarn, code, path, message);

    /// <summary>The reference prints a missing value as <c>undefined</c>.</summary>
    private static string Show(object? value) => value switch
    {
        null => "undefined",
        // Invariant: a message is bytes the other ports reproduce, whatever the machine's culture.
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? "undefined",
    };

    private static string Invariant(FormattableString text) => text.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// Names the FIRST segment of a non-empty, unresolvable <paramref name="path"/> under
    /// <paramref name="obj"/>, and the node it was looked for under:
    /// <c>acme::shop::Order.reference.display</c> with <c>reference</c> still present reads
    /// "'acme::shop::Order.reference' has no member 'display'", not the whole tail.
    /// </summary>
    private static string MissingMemberHint(MetaData obj, IReadOnlyList<string> path)
    {
        var found = 0;
        while (found < path.Count - 1 && RequirementClaims.ResolveMember(obj, path.Take(found + 1).ToList()) is not null)
            found++;
        var parent = string.Join(CHILD_REF_SEPARATOR, new[] { obj.ResolutionKey() }.Concat(path.Take(found)));
        return $" '{parent}' has no member '{path[found]}'.";
    }

    // -- the summary ------------------------------------------------------------------------

    /// <summary>
    /// Count what the ledger contains, for the line <c>verify</c> prints on EVERY run, clean or
    /// not. Silence is ambiguous: a run that prints nothing cannot be told apart from a run that
    /// checked nothing. Null when the model declares no requirement.
    /// </summary>
    public static RequirementSummary? Summarise(MetaData root, RequirementScan scan)
    {
        var reqs = scan.Addressed;
        if (reqs.Count == 0) return null; // opt-in by declaration

        int functional = 0, architectural = 0, undecided = 0, deferredUntracked = 0;
        var byStatus = new Dictionary<string, int>(StringComparer.Ordinal);

        // `undecided` counts only the requirements a `@disposition` could actually SETTLE. A
        // parent is `partial` because a descendant is, so a disposition on it would settle
        // nothing and name no work. EVERY ancestor of a node with outstanding work is excluded
        // (real ledgers are five deep), and it marks its ancestors whether or not it is itself
        // DISPOSED: once the only outstanding leaf under a parent has been ruled on, nothing
        // beneath that parent is owed, so the parent must not be resurrected as a fresh
        // decision by the roll-up status the ruled-on child gave it. Ancestry comes from the
        // scan's own dotted PATHS, so it cannot disagree with how every other check addresses
        // a node; `::` carries no dot, so splitting on "." keeps a package-qualified segment.
        var rollUpAncestors = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (node, path) in reqs)
        {
            if (!node.HasOutstandingWork()) continue;
            var segments = path.Split('.');
            for (var i = 1; i < segments.Length; i++)
                rollUpAncestors.Add(string.Join('.', segments.Take(i)));
        }

        foreach (var (req, path) in reqs)
        {
            if (req.IsArchitectural()) architectural++; else functional++;

            // byStatus is UNCHANGED by the roll-up on purpose: a roll-up parent is still
            // genuinely `partial`. Only the "decisions owed" count narrows.
            if (req.Status is { } status) byStatus[status] = byStatus.GetValueOrDefault(status) + 1;

            if (req.HasOutstandingWork() && req.Disposition is null && !rollUpAncestors.Contains(path))
                undecided++;
            if (req.Disposition == REQUIREMENT_DISPOSITION_DEFERRED && req.TrackedBy.Count == 0)
                deferredUntracked++;
        }

        // Both sides of the ratio come from the SAME scan the gate read.
        int? entitiesClaimed = null, entitiesTotal = null;
        if (scan.MeasureCoverage)
        {
            var entities = CoverableEntities(root);
            entitiesTotal = entities.Count;
            entitiesClaimed = entities.Count(e => scan.ClaimedObjects.Contains(e.ResolutionKey()));
        }

        return new RequirementSummary(
            reqs.Count, functional, architectural, byStatus, undecided, deferredUntracked,
            entitiesClaimed, entitiesTotal);
    }
}
