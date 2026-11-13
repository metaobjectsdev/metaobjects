// `verify` — the business-rules gate (ADR-0063).
//
// The loader refuses a model whose operations or lifecycles are malformed. This gate reports
// what loads clean but is almost certainly not what the author meant: a state nothing can
// reach, a lifecycle that cannot move, a transition nothing can make, and (by setting) a
// permission name the model derived instead of declaring.
//
// TypeScript is the reference (server/typescript/packages/cli/src/lib/rules-check.ts); this
// port implements the same checks with the same codes, severities, paths and message text,
// and fixtures/rules-check-conformance/ is the contract. A model that declares no operation
// and no transition gets no diagnostics, no summary and no gate row: opt-in by declaration.
//
// Checks, in the order they are reported:
//   WARN_LIFECYCLE_UNREACHABLE_STATE   states no transition reaches from the initial state
//                                      (severity: `verify.lifecycle.unreachable`)
//   WARN_LIFECYCLE_INITIAL_TERMINAL    the initial state is one no transition leaves
//   WARN_TRANSITION_UNREACHABLE        a transition whose every @from state is unreachable
//                                      (severity: `verify.lifecycle.unreachable`)
//   WARN_PERMISSION_DERIVED_NAME       a transition that derives its own command, or an
//                                      operation, with no @permission and not @public
//                                      (severity: `rules.permissions.names`)
//
// Lifecycles are checked once per declaring field, so a lifecycle on an abstract base is
// reported once, not once per inheritor. A derived command exists per concrete entity, so
// the permission check runs per concrete entity and names it.

using System.Globalization;
using MetaObjects.Config;
using MetaObjects.Core.Requirement;
using MetaObjects.Meta;

namespace MetaObjects.Core.Transition;

/// <summary>What the model declares, for the line `verify` prints on every run.</summary>
/// <param name="Operations">Declared operations, across every <c>api.operational</c>.</param>
/// <param name="Lifecycles">Lifecycles: enum fields that declare at least one transition.</param>
/// <param name="Transitions">Declared transitions, across every lifecycle.</param>
public sealed record RulesSummary(int Operations, int Lifecycles, int Transitions);

/// <summary>The rules gate's result. <see cref="Summary"/> is null when the model declares no operation and no transition.</summary>
public sealed record RulesCheckResult(IReadOnlyList<RequirementDiagnostic> Diagnostics, RulesSummary? Summary);

/// <summary>The business-rules gate.</summary>
public static class RulesCheck
{
    public const string SeverityError = "error";
    public const string SeverityWarn = "warn";

    public const string WARN_LIFECYCLE_UNREACHABLE_STATE = "WARN_LIFECYCLE_UNREACHABLE_STATE";
    public const string WARN_LIFECYCLE_INITIAL_TERMINAL = "WARN_LIFECYCLE_INITIAL_TERMINAL";
    public const string WARN_TRANSITION_UNREACHABLE = "WARN_TRANSITION_UNREACHABLE";
    public const string WARN_PERMISSION_DERIVED_NAME = "WARN_PERMISSION_DERIVED_NAME";

    private static string QuoteList(IEnumerable<string> xs) => string.Join(", ", xs.Select(x => $"\"{x}\""));

    /// <summary>A node's package-qualified address: <c>acme::shop::Order.status.submit</c>.</summary>
    public static string Address(MetaData node)
    {
        var parts = new List<string>();
        for (MetaData? n = node; n is not null && n.Parent is not null; n = n.Parent)
        {
            if (n.Name != "") parts.Insert(0, n.Name);
        }
        var pkg = NamingRefs.EffectivePackageOf(NamingRefs.TopLevelNodeOf(node));
        var dotted = string.Join(".", parts);
        return pkg.Length == 0 ? dotted : $"{pkg}{PACKAGE_SEPARATOR}{dotted}";
    }

    /// <summary>The permission name a node gets when it declares none: <c>&lt;package&gt;.&lt;name&gt;</c>.</summary>
    private static string DerivedPermissionName(MetaData owner, string name)
    {
        var pkg = NamingRefs.EffectivePackageOf(NamingRefs.TopLevelNodeOf(owner));
        return pkg.Length == 0 ? name : $"{pkg}.{name}";
    }

    private static bool NeedsPermissionName(MetaData node) =>
        node.Attr(OPERATION_ATTR_PERMISSION) is null && node.Attr(OPERATION_ATTR_PUBLIC) is not true;

    private static List<MetaData> Entities(MetaData root) =>
        root.Children().Where(c => c.Type == TYPE_OBJECT && c.SubType == OBJECT_SUBTYPE_ENTITY).ToList();

    private static List<MetaData> Operations(MetaData root) =>
        root.Children().Where(c => c.Type == TYPE_API)
            .SelectMany(api => api.Children().Where(c => c.Type == TYPE_OPERATION)).ToList();

    /// <summary>Every lifecycle of the model, once per declaring field, in model order.</summary>
    private static List<Lifecycle> DeclaredLifecycles(MetaData root)
    {
        var seen = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
        var output = new List<Lifecycle>();
        foreach (var entity in Entities(root))
        {
            foreach (var l in Lifecycles.LifecyclesOf(entity))
            {
                if (!seen.Add(l.Field)) continue;
                output.Add(l);
            }
        }
        return output;
    }

    private static void CheckLifecycle(Lifecycle l, RulesSettings settings, List<RequirementDiagnostic> output)
    {
        var where = Address(l.Field);
        var initial = l.Initial;
        if (initial is null) return; // the loader refused this model (ERR_LIFECYCLE_NO_INITIAL)
        var reachable = Lifecycles.ReachableStates(l);
        string? unreachableSeverity = settings.LifecycleUnreachable == "off" ? null : settings.LifecycleUnreachable;

        if (unreachableSeverity is not null)
        {
            var unreachable = l.States.Where(s => !reachable.Contains(s)).ToList();
            if (unreachable.Count > 0)
            {
                output.Add(new RequirementDiagnostic(unreachableSeverity, WARN_LIFECYCLE_UNREACHABLE_STATE, where,
                    $"{(unreachable.Count == 1 ? "state" : "states")} {QuoteList(unreachable)} of \"{l.Field.Name}\" " +
                    $"cannot be reached from the initial state \"{initial}\" by any transition. " +
                    "Add the transition that leads there, or set verify.lifecycle.unreachable if only seeded data uses " +
                    $"{(unreachable.Count == 1 ? "it" : "them")}."));
            }
        }

        if (Lifecycles.TerminalStates(l).Contains(initial))
        {
            output.Add(new RequirementDiagnostic(SeverityWarn, WARN_LIFECYCLE_INITIAL_TERMINAL, where,
                $"the initial state \"{initial}\" of \"{l.Field.Name}\" is terminal: no transition leaves it, " +
                "so no row of this lifecycle can ever move."));
        }

        if (unreachableSeverity is not null)
        {
            foreach (var t in l.Transitions)
            {
                var from = Lifecycles.TransitionFrom(t);
                if (from.Count == 0 || from.Any(reachable.Contains)) continue;
                output.Add(new RequirementDiagnostic(unreachableSeverity, WARN_TRANSITION_UNREACHABLE, Address(t),
                    $"transition \"{t.Name}\" starts only from {QuoteList(from)}, which no transition reaches from " +
                    $"the initial state \"{initial}\", so it can never be made."));
            }
        }
    }

    /// <summary>The transition names each declared command claims, per target entity.</summary>
    private static Dictionary<MetaData, HashSet<string>> ClaimedTransitions(MetaData root)
    {
        var claimed = new Dictionary<MetaData, HashSet<string>>(ReferenceEqualityComparer.Instance);
        foreach (var op in Operations(root))
        {
            if (op.SubType != OPERATION_SUBTYPE_COMMAND) continue;
            var target = Lifecycles.OperationTarget(op);
            if (target is null) continue;
            var names = Lifecycles.StringList(op, OPERATION_ATTR_TRANSITIONS);
            if (names.Count == 0) continue;
            if (!claimed.TryGetValue(target, out var set)) claimed[target] = set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var n in names) set.Add(n);
        }
        return claimed;
    }

    private static void CheckPermissionNames(MetaData root, RulesSettings settings, List<RequirementDiagnostic> output)
    {
        if (settings.PermissionNames == "derive") return;
        var severity = settings.PermissionNames == "require" ? SeverityError : SeverityWarn;
        static string Advice(string kind) => $"which changes if the {kind} is renamed. Declare @permission, or @public: true.";

        if (settings.LifecycleCommands != "none")
        {
            var claimed = ClaimedTransitions(root);
            foreach (var entity in Entities(root))
            {
                if (entity.IsAbstract) continue;
                foreach (var t in Lifecycles.EntityTransitions(entity))
                {
                    if (settings.LifecycleCommands == "unclaimed"
                        && claimed.TryGetValue(entity, out var names) && names.Contains(t.Name)) continue;
                    if (!NeedsPermissionName(t)) continue;
                    output.Add(new RequirementDiagnostic(severity, WARN_PERMISSION_DERIVED_NAME,
                        $"{Address(entity)}.{t.Parent?.Name ?? ""}.{t.Name}",
                        $"the command derived from transition \"{t.Name}\" of \"{entity.Name}\" has no @permission, so it asks " +
                        $"the policy about the derived name \"{DerivedPermissionName(entity, t.Name)}\", {Advice("transition")}"));
                }
            }
        }

        foreach (var op in Operations(root))
        {
            if (!NeedsPermissionName(op)) continue;
            output.Add(new RequirementDiagnostic(severity, WARN_PERMISSION_DERIVED_NAME, Address(op),
                $"operation.{op.SubType} \"{op.Name}\" has no @permission, so it asks the policy about the derived " +
                $"name \"{DerivedPermissionName(op, op.Name)}\", {Advice("operation")}"));
        }
    }

    /// <summary>The rules gate over a loaded model.</summary>
    public static RulesCheckResult Check(MetaData root, RulesSettings settings)
    {
        var lifecycles = DeclaredLifecycles(root);
        var ops = Operations(root);
        if (lifecycles.Count == 0 && ops.Count == 0) return new RulesCheckResult([], null);

        var diagnostics = new List<RequirementDiagnostic>();
        foreach (var l in lifecycles) CheckLifecycle(l, settings, diagnostics);
        CheckPermissionNames(root, settings, diagnostics);
        return new RulesCheckResult(
            diagnostics,
            new RulesSummary(ops.Count, lifecycles.Count, lifecycles.Sum(l => l.Transitions.Count)));
    }
}
