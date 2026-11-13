// ADR-0063 — cross-node rules for operations (slice A) and lifecycles (slice B).
//
// Ported rule-for-rule, WITH THE SAME MESSAGE TEXT, from the TS reference
// server/typescript/packages/metadata/src/loader/rules-validation.ts; the fixtures under
// fixtures/conformance/ (`error-rules-*`, with the positive `rules-*` cases) are the contract.
//
// One broken rule yields one error:
//   - Each error's source is the offending node: the transition, the enum field (L3), the
//     entity (L2b), the operation or the binding.
//   - An operation whose @inputRef / @outputRef fails O1 is not checked further; one whose
//     target fails O2 or O3 is not checked for O4 or O5.
//   - An error is reported once per (node, code), so a broken transition on an abstract base
//     is reported once, not once per inheritor.
//
// Rules:
//   L1 ERR_TRANSITION_NOT_ON_ENTITY   a transition under an enum field not declared on an object.entity
//   L2 ERR_TRANSITION_NOT_ON_ENTITY   a concrete entity with a lifecycle and no writable source (on the entity)
//   L3 ERR_LIFECYCLE_NO_INITIAL       an enum field declaring transitions has no @default
//   L4 ERR_TRANSITION_UNKNOWN_STATE   a @from or @to value is not one of the enum's @values
//   L5 ERR_TRANSITION_NAME_COLLISION  a transition named create/get/list/update/delete
//   L6 ERR_TRANSITION_NAME_COLLISION  two transitions of one entity (across its lifecycles) share a name
//   L7 ERR_BAD_ATTR_VALUE             @condition names a field the entity does not have, or is not boolean
//   P1 ERR_PERMISSION_PUBLIC_CONFLICT @public: true with @permission (operation or transition)
//   O0 ERR_TRANSITION_NAME_COLLISION  an operation named create/get/list/update/delete
//   O1 ERR_OPERATION_SHAPE            @inputRef is not an object.value; @outputRef is not an entity, projection or value
//   O2 ERR_OPERATION_TARGET_UNRESOLVED @objectRef is not an object.entity, or a command lists
//                                      @transitions and no target is declared or derivable
//   O3 ERR_OPERATION_TARGET_MISMATCH  a declared @objectRef disagrees with the derived target
//   O4 ERR_OPERATION_UNKNOWN_TRANSITION a @transitions name is not a transition of the target
//   O5 ERR_BAD_ATTR_VALUE             an @errors code is not lower snake case, or is listed twice
//   B1 ERR_BINDING_PATH_MISMATCH      a binding.rest @path's placeholders are not the target's key fields
//                                      (a keyed operation) or are not empty (an unkeyed one)

using System.Text.RegularExpressions;
using MetaObjects.Core.Transition;
using MetaObjects.Meta;

namespace MetaObjects.Loader;

public static partial class ValidationPasses
{
    private static readonly string ReservedOperationNameList = string.Join(", ", RESERVED_OPERATION_NAMES);

    private static readonly Regex BindingPlaceholder = new(@"\{([^}]*)\}", RegexOptions.CultureInvariant);

    /// <summary><c>"Entity.field.transition"</c> for a transition, <c>"Api.operation"</c> for an operation.</summary>
    private static string RulesLabel(MetaData node)
    {
        var parts = new List<string>();
        // A binding is unnamed: its label is its operation's.
        for (MetaData? n = node; n is not null && n.Parent is not null; n = n.Parent)
        {
            if (n.Name != "") parts.Insert(0, n.Name);
        }
        return string.Join(".", parts);
    }

    private static string RulesQuoteList(IEnumerable<string> xs) => string.Join(", ", xs.Select(x => $"\"{x}\""));

    private sealed class RulesErrorSink
    {
        public readonly List<MetaError> Errors = [];
        private readonly Dictionary<MetaData, HashSet<ErrorCode>> _seen = new(ReferenceEqualityComparer.Instance);

        public void Add(MetaData node, ErrorCode code, string message)
        {
            if (!_seen.TryGetValue(node, out var codes)) _seen[node] = codes = [];
            if (!codes.Add(code)) return;
            Errors.Add(new MetaError(message, code, Envelope: node.Source));
        }
    }

    private static void CheckPermissionPublic(MetaData node, RulesErrorSink sink)
    {
        if (node.Attr(OPERATION_ATTR_PUBLIC) is true && node.Attr(OPERATION_ATTR_PERMISSION) is not null)
        {
            sink.Add(node, ErrorCode.ERR_PERMISSION_PUBLIC_CONFLICT,
                $"{node.Type}.{node.SubType} \"{RulesLabel(node)}\" declares both @public: true and @permission; a public {node.Type} calls no permission check, so remove one.");
        }
    }

    /// <summary>L1, L3, L4, L5, L7 and P1 for the transitions declared on one field.</summary>
    private static void CheckDeclaredTransitions(MetaData field, RulesErrorSink sink)
    {
        // ADR-0039: own — each transition is checked where it is declared.
        var declared = field.OwnChildren().Where(c => c.Type == TYPE_TRANSITION && c.SubType == TRANSITION_SUBTYPE_ACTION).ToList();
        if (declared.Count == 0) return;
        var owner = field.Parent;
        if (owner is null || owner.Type != TYPE_OBJECT || owner.SubType != OBJECT_SUBTYPE_ENTITY)
        {
            var where = owner is null || owner.Type != TYPE_OBJECT ? "the document root" : $"object.{owner.SubType} \"{owner.Name}\"";
            foreach (var t in declared)
            {
                sink.Add(t, ErrorCode.ERR_TRANSITION_NOT_ON_ENTITY,
                    $"transition.action \"{RulesLabel(t)}\" is declared on a field of {where}; a lifecycle belongs to an object.entity with a writable source.");
            }
            return;
        }
        if (field.SubType == FIELD_SUBTYPE_ENUM && field.Attr(FIELD_ATTR_DEFAULT) is not string)
        {
            sink.Add(field, ErrorCode.ERR_LIFECYCLE_NO_INITIAL,
                $"field.enum \"{RulesLabel(field)}\" declares transitions but no @default; its @default is the lifecycle's initial state.");
        }
        var stateList = Lifecycles.StringList(field, FIELD_ATTR_VALUES).Distinct(StringComparer.Ordinal).ToList();
        var states = stateList.ToHashSet(StringComparer.Ordinal);
        foreach (var t in declared)
        {
            CheckPermissionPublic(t, sink);
            var to = Lifecycles.TransitionTo(t);
            var unknown = Lifecycles.TransitionFrom(t).Concat(to is null ? [] : [to])
                .Distinct(StringComparer.Ordinal).Where(s => !states.Contains(s)).ToList();
            if (unknown.Count > 0)
            {
                sink.Add(t, ErrorCode.ERR_TRANSITION_UNKNOWN_STATE,
                    $"transition.action \"{RulesLabel(t)}\" names {RulesQuoteList(unknown)}, which {(unknown.Count == 1 ? "is not a member" : "are not members")} of \"{field.Name}\" @values ({RulesQuoteList(stateList)}).");
            }
            if (RESERVED_OPERATION_NAMES.Contains(t.Name))
            {
                sink.Add(t, ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                    $"transition.action \"{RulesLabel(t)}\" is named \"{t.Name}\", which is a derived CRUD verb ({ReservedOperationNameList}); rename it.");
            }
            var condition = t.Attr(TRANSITION_ATTR_CONDITION);
            if (condition is not null && owner is MetaObject ownerObject)
            {
                var message = ConditionMessage(condition, ownerObject, $"transition.action \"{RulesLabel(t)}\" @condition");
                if (message is not null) sink.Add(t, ErrorCode.ERR_BAD_ATTR_VALUE, message);
            }
        }
    }

    /// <summary>Every field declared in the tree: at the root and on every object.</summary>
    private static List<MetaData> RulesDeclaredFields(MetaData root)
    {
        var output = new List<MetaData>();
        // ADR-0039: own — a structural walk over the declarations themselves.
        foreach (var top in root.OwnChildren())
        {
            if (top.Type == TYPE_FIELD) output.Add(top);
            else if (top.Type == TYPE_OBJECT) output.AddRange(top.OwnChildren().Where(c => c.Type == TYPE_FIELD));
        }
        return output;
    }

    /// <summary>L2 and L6 for one entity, over its effective (inherited) lifecycles.</summary>
    private static void CheckEntityLifecycles(MetaData entity, RulesErrorSink sink)
    {
        var transitions = Lifecycles.EntityTransitions(entity);
        if (transitions.Count == 0) return;
        var byName = new Dictionary<string, MetaData>(StringComparer.Ordinal);
        foreach (var t in transitions)
        {
            if (!byName.TryGetValue(t.Name, out var first))
            {
                byName[t.Name] = t;
            }
            else if (!ReferenceEquals(first, t))
            {
                sink.Add(t, ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                    $"transition.action \"{RulesLabel(t)}\" has the same name as \"{RulesLabel(first)}\"; the transitions of \"{entity.Name}\" share one namespace (each may derive a command), so rename one.");
            }
        }
        if (!entity.IsAbstract && !entity.Children().Any(c => c is MetaSource ms && ms.IsWritable()))
        {
            sink.Add(entity, ErrorCode.ERR_TRANSITION_NOT_ON_ENTITY,
                $"object.entity \"{entity.Name}\" has a lifecycle (transitions on {RulesQuoteList(transitions.Select(t => t.Parent?.Name ?? "").Distinct(StringComparer.Ordinal))}) but no writable source; a transition is a guarded update of a stored row.");
        }
    }

    /// <summary>O0-O5, P1 and B1 for one operation.</summary>
    private static void CheckOperation(MetaData op, RulesErrorSink sink)
    {
        if (RESERVED_OPERATION_NAMES.Contains(op.Name))
        {
            sink.Add(op, ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                $"operation.{op.SubType} \"{RulesLabel(op)}\" is named \"{op.Name}\", which is a derived CRUD verb ({ReservedOperationNameList}); rename it.");
        }
        CheckPermissionPublic(op, sink);

        var errorCodes = Lifecycles.StringList(op, OPERATION_ATTR_ERRORS);
        var bad = errorCodes.Where(c => !BUSINESS_ERROR_CODE_PATTERN.IsMatch(c)).ToList();
        var dup = errorCodes.Where((c, i) => errorCodes.ToList().IndexOf(c) != i).ToList();
        if (bad.Count > 0 || dup.Count > 0)
        {
            var dupSet = dup.Distinct(StringComparer.Ordinal).ToList();
            var why = bad.Count > 0
                ? $"{RulesQuoteList(bad)} {(bad.Count == 1 ? "is not a" : "are not")} lower snake case code{(bad.Count == 1 ? "" : "s")}"
                : $"{RulesQuoteList(dupSet)} {(dupSet.Count == 1 ? "is" : "are")} listed twice";
            sink.Add(op, ErrorCode.ERR_BAD_ATTR_VALUE, $"operation.{op.SubType} \"{RulesLabel(op)}\" @errors: {why}.");
        }

        // O1 — shapes.
        if (op.Attr(OPERATION_ATTR_INPUT_REF) is string inputRef)
        {
            var input = Lifecycles.ResolveObjectOn(op, inputRef);
            if (input is null || input.SubType != OBJECT_SUBTYPE_VALUE)
            {
                sink.Add(op, ErrorCode.ERR_OPERATION_SHAPE,
                    $"operation.{op.SubType} \"{RulesLabel(op)}\" @inputRef \"{inputRef}\" {(input is null ? "names no object" : $"is an object.{input.SubType}")}; an operation's input is an object.value.");
                return;
            }
        }
        if (op.Attr(OPERATION_ATTR_OUTPUT_REF) is string outputRef)
        {
            var output = Lifecycles.ResolveObjectOn(op, outputRef);
            var legal = output is not null &&
                (output.SubType == OBJECT_SUBTYPE_ENTITY || output.SubType == OBJECT_SUBTYPE_PROJECTION || output.SubType == OBJECT_SUBTYPE_VALUE);
            if (!legal)
            {
                sink.Add(op, ErrorCode.ERR_OPERATION_SHAPE,
                    $"operation.{op.SubType} \"{RulesLabel(op)}\" @outputRef \"{outputRef}\" {(output is null ? "names no object" : $"is an object.{output.SubType}")}; an operation returns an object.entity, object.projection or object.value.");
                return;
            }
        }

        // O2, O3 — the target.
        var derived = Lifecycles.DeriveOperationTarget(op)?.Entity;
        var target = derived;
        if (op.Attr(OPERATION_ATTR_OBJECT_REF) is string objectRef)
        {
            var declared = Lifecycles.ResolveObjectOn(op, objectRef);
            if (declared is null || declared.SubType != OBJECT_SUBTYPE_ENTITY)
            {
                sink.Add(op, ErrorCode.ERR_OPERATION_TARGET_UNRESOLVED,
                    $"operation.{op.SubType} \"{RulesLabel(op)}\" @objectRef \"{objectRef}\" {(declared is null ? "names no object" : $"is an object.{declared.SubType}")}; an operation acts on an object.entity.");
                return;
            }
            if (derived is not null && !ReferenceEquals(derived, declared))
            {
                sink.Add(op, ErrorCode.ERR_OPERATION_TARGET_MISMATCH,
                    $"operation.{op.SubType} \"{RulesLabel(op)}\" @objectRef names \"{declared.Name}\", but its input and output derive \"{derived.Name}\"; remove @objectRef or make them agree.");
                return;
            }
            target = declared;
        }
        var transitions = op.SubType == OPERATION_SUBTYPE_COMMAND ? Lifecycles.StringList(op, OPERATION_ATTR_TRANSITIONS) : [];
        if (transitions.Count > 0 && target is null)
        {
            sink.Add(op, ErrorCode.ERR_OPERATION_TARGET_UNRESOLVED,
                $"operation.command \"{RulesLabel(op)}\" lists @transitions but has no target entity: no @inputRef field extends an entity's primary key, no @outputRef has a base entity, and there is no @objectRef.");
            return;
        }

        // O4 — the transitions it may make.
        if (target is not null && transitions.Count > 0)
        {
            var known = Lifecycles.EntityTransitions(target).Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
            var unknown = transitions.Distinct(StringComparer.Ordinal).Where(n => !known.Contains(n)).ToList();
            if (unknown.Count > 0)
            {
                sink.Add(op, ErrorCode.ERR_OPERATION_UNKNOWN_TRANSITION,
                    $"operation.command \"{RulesLabel(op)}\" @transitions names {RulesQuoteList(unknown)}, which {(unknown.Count == 1 ? "is not a transition" : "are not transitions")} of \"{target.Name}\".");
            }
        }

        // B1 — binding paths.
        // ADR-0039: own — a binding is checked on the operation that declares it.
        foreach (var b in op.OwnChildren())
        {
            if (b.Type != TYPE_BINDING || b.SubType != BINDING_SUBTYPE_REST) continue;
            if (b.Attr(BINDING_ATTR_PATH) is not string path) continue;
            var placeholders = BindingPlaceholder.Matches(path).Select(m => m.Groups[1].Value).ToList();
            IReadOnlyList<string> expected = target is not null && Lifecycles.OperationIsKeyed(op) ? Lifecycles.PrimaryKeyFields(target) : [];
            var sortedPlaceholders = placeholders.Order(StringComparer.Ordinal).ToList();
            var sortedExpected = expected.Order(StringComparer.Ordinal).ToList();
            var same = sortedPlaceholders.Count == sortedExpected.Count && sortedPlaceholders.SequenceEqual(sortedExpected);
            if (!same)
            {
                sink.Add(b, ErrorCode.ERR_BINDING_PATH_MISMATCH,
                    $"binding.rest on \"{RulesLabel(b)}\" @path \"{path}\" has placeholders [{RulesQuoteList(placeholders)}]; " +
                    (expected.Count == 0
                        ? $"\"{RulesLabel(op)}\" addresses no row by key, so its path takes none."
                        : $"\"{RulesLabel(op)}\" addresses one \"{target!.Name}\" by key, so its path takes exactly [{RulesQuoteList(expected)}]."));
            }
        }
    }

    /// <summary>ADR-0063 — the rules pass. Runs after reference-bearing validation, before freeze.</summary>
    public static IReadOnlyList<MetaError> ValidateRules(MetaData root)
    {
        var sink = new RulesErrorSink();
        foreach (var field in RulesDeclaredFields(root)) CheckDeclaredTransitions(field, sink);
        foreach (var obj in root.Children())
        {
            if (obj.Type == TYPE_OBJECT && obj.SubType == OBJECT_SUBTYPE_ENTITY) CheckEntityLifecycles(obj, sink);
        }
        foreach (var api in root.Children())
        {
            if (api.Type != TYPE_API) continue;
            foreach (var op in api.Children())
            {
                if (op.Type == TYPE_OPERATION) CheckOperation(op, sink);
            }
        }
        return sink.Errors;
    }
}
