// rules-names-generator — ADR-0067 layer 0, the business-rules half: compile-time constants for
// every state, transition, permission and error the model declares or derives (ADR-0066), so hand
// code that names one stops compiling when the model renames it.
//
// Three kinds of file, each only when the model has something to put in it:
//
//   <Entity>Rules.g.cs        one per in-scope object.entity with a lifecycle: a nested class per
//                             lifecycle field holding its states, initial state, terminal states,
//                             transitions and, for each transition that derives a command, the
//                             permission that command asks the policy about.
//   <Api>Operations.g.cs      one per api.operational: a nested class per operation holding its
//                             name, its permission and its declared @errors codes.
//   RuleErrorCodes.g.cs       once per run: the codes the enforcing shell answers on its own.
//
// Everything here is DERIVED through the same code `verify`'s rules gate runs
// (MetaObjects.Core.Transition), so a permission name codegen writes is the one `verify` reports.
// A permission is absent for a @public command or operation: there is nothing to ask the policy.
//
// A layer generator, separate from the flat ones (ADR-0067 §5.2): it acts on the rules vocabulary
// by design, so fixtures/codegen-noop/rules/ does not hold it to identical output.
//
// const, not static readonly, for every single name, so a constant can stand in an attribute
// argument or a switch label; the terminal-state list is the one collection, and a collection
// cannot be const.

using MetaObjects.Codegen.Writer;
using MetaObjects.Config;
using MetaObjects.Core.Transition;
using MetaObjects.Meta;
using static MetaObjects.Core.Api.ApiConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates the business-rules name constants: states, transitions, permissions and errors.</summary>
public class RulesNamesGenerator : IGenerator
{
    public virtual string Name => "rules-names";

    /// <summary>
    /// Scope this entry to some objects (set on the entry in <c>codegen/Generators.cs</c>). An entity's
    /// file is written when it accepts the entity; an API's when it accepts at least one object of the
    /// API's package, so a package-level choice covers that package's operations too. <c>null</c>
    /// accepts everything.
    /// </summary>
    public Func<MetaObject, bool>? Include { get; init; }

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var narrowed = ctx.Narrow(Include);
        var settings = ctx.Root.Rules;
        var files = new List<EmittedFile>();

        foreach (var entity in narrowed.Entities)
        {
            if (Lifecycles.LifecyclesOf(entity).Count == 0) continue;
            if (RenderEntity(entity, ctx, settings) is { } file) files.Add(file);
        }

        var packages = narrowed.Entities
            .Select(e => PackageBindingResolver.EffectivePackage(e) ?? "")
            .ToHashSet(StringComparer.Ordinal);
        foreach (var api in Apis(ctx.Root))
        {
            if (Include is not null && !packages.Contains(PackageBindingResolver.EffectivePackage(api) ?? "")) continue;
            if (Operations(api).Count == 0) continue;
            if (RenderApi(api, ctx) is { } file) files.Add(file);
        }

        // The shell codes are written once the run wrote anything else: a model with no lifecycle and no
        // operation gets no file at all.
        if (files.Count > 0 && RenderShellErrors(ctx) is { } shell) files.Add(shell);
        return files;
    }

    /// <summary>The in-scope <c>api.operational</c> nodes of the model, in model order.</summary>
    protected static IReadOnlyList<MetaData> Apis(MetaRoot root) =>
        root.Children().Where(c => c.Type == TYPE_API && c.SubType == API_SUBTYPE_OPERATIONAL
                && (root.ImportScope?.InScope(c.ResolutionKey()) ?? true)).ToList();

    /// <summary>The operations of an API, in declaration order.</summary>
    protected static IReadOnlyList<MetaData> Operations(MetaData api) =>
        api.Children().Where(c => c.Type == TYPE_OPERATION).ToList();

    // ---- the entity file ------------------------------------------------------------------------

    /// <summary>The <c>&lt;Entity&gt;Rules.g.cs</c> file of an entity with at least one lifecycle.
    /// Override to adjust it, or to answer null for an entity whose names an adopter supplies itself.</summary>
    protected virtual EmittedFile? RenderEntity(MetaObject entity, GenContext ctx, RulesSettings settings)
    {
        var cls = CSharpNaming.Pascal(entity.Name) + "Rules";
        var ns = Namespace(ctx, entity, cls);
        var commands = new HashSet<MetaData>(RulesCheck.CommandTransitions(ctx.Root, settings, entity), ReferenceEqualityComparer.Instance);

        var w = NewWriter();
        WriteFileHeader(w);
        w.Blank();
        w.Line($"namespace {ns};");
        w.Blank();
        w.DocSummary($"GENERATED — the lifecycle names of {CSharpNaming.Pascal(entity.Name)}: states, transitions and the permissions its derived commands ask for (ADR-0066).");
        using (w.Braced($"public static class {cls}"))
        {
            var lifecycleClasses = new Members(entity.Name + " lifecycles");
            var first = true;
            foreach (var l in Lifecycles.LifecyclesOf(entity))
            {
                if (!first) w.Blank();
                first = false;
                WriteLifecycle(w, entity, l, commands, lifecycleClasses.Add(Ident(l.Field.Name), $"field \"{l.Field.Name}\""));
            }
        }
        return new EmittedFile(OutputPaths.Of(entity, ctx, $"{cls}.g.cs"), w.ToString());
    }

    /// <summary>One lifecycle field as a nested class.</summary>
    protected virtual void WriteLifecycle(CsWriter w, MetaObject entity, Lifecycle l, IReadOnlySet<MetaData> commands, string cls)
    {
        var where = $"{entity.Name}.{l.Field.Name}";
        w.DocSummary($"The lifecycle held in field \"{l.Field.Name}\".");
        using (w.Braced($"public static class {cls}"))
        {
            Const(w, "Field", l.Field.Name);
            if (l.Initial is { } initial)
            {
                w.DocSummary("The state a new row starts in: the enum's @default.");
                Const(w, "Initial", initial);
            }
            w.DocSummary("The states no transition leaves.");
            w.Line("public static readonly System.Collections.Generic.IReadOnlyList<string> TerminalStates = " +
                   $"[{string.Join(", ", Lifecycles.TerminalStates(l).Select(Literal))}];");
            w.Blank();

            WriteGroup(w, "States", "The lifecycle's states: the enum's @values.", $"{where} states",
                l.States.Select(s => (s, $"state \"{s}\"")));
            w.Blank();
            WriteGroup(w, "Transitions", "The lifecycle's transitions.", $"{where} transitions",
                l.Transitions.Select(t => (t.Name, $"transition \"{t.Name}\"")));

            var permissions = l.Transitions
                .Where(commands.Contains)
                .Select(t => (Transition: t, Permission: RulesCheck.TransitionCommandPermission(entity, t)))
                .Where(p => p.Permission is not null)
                .ToList();
            if (permissions.Count > 0)
            {
                w.Blank();
                var members = new Members($"{where} permissions");
                w.DocSummary("The permission each derived command asks the policy about, by transition. A @public " +
                             "transition, and one a declared command makes, has none.");
                using (w.Braced("public static class Permissions"))
                {
                    foreach (var (t, permission) in permissions)
                        Const(w, members.Add(Ident(t.Name), $"transition \"{t.Name}\""), permission!);
                }
            }
        }
    }

    // ---- the API file ---------------------------------------------------------------------------

    /// <summary>The <c>&lt;Api&gt;Operations.g.cs</c> file of an <c>api.operational</c>.</summary>
    protected virtual EmittedFile? RenderApi(MetaData api, GenContext ctx)
    {
        var cls = CSharpNaming.Pascal(api.Name) + "Operations";
        var ns = Namespace(ctx, api, cls);

        var w = NewWriter();
        WriteFileHeader(w);
        w.Blank();
        w.Line($"namespace {ns};");
        w.Blank();
        w.DocSummary($"GENERATED — the operations of API \"{api.Name}\": each one's name, permission and declared error codes (ADR-0066).");
        using (w.Braced($"public static class {cls}"))
        {
            var members = new Members($"api \"{api.Name}\" operations");
            var first = true;
            foreach (var op in Operations(api))
            {
                if (!first) w.Blank();
                first = false;
                WriteOperation(w, op, members.Add(Ident(op.Name), $"operation \"{op.Name}\""));
            }
        }
        return new EmittedFile(OutputPaths.Of(api, ctx, $"{cls}.g.cs"), w.ToString());
    }

    /// <summary>One operation as a nested class.</summary>
    protected virtual void WriteOperation(CsWriter w, MetaData op, string cls)
    {
        w.DocSummary($"operation.{op.SubType} \"{op.Name}\".");
        using (w.Braced($"public static class {cls}"))
        {
            Const(w, "Name", op.Name);
            if (RulesCheck.OperationPermission(op) is { } permission)
            {
                w.DocSummary("The permission the operation asks the policy about.");
                Const(w, "Permission", permission);
            }
            var errors = Lifecycles.StringList(op, OPERATION_ATTR_ERRORS);
            if (errors.Count > 0)
            {
                w.Blank();
                WriteGroup(w, "Errors", "The business error codes a body may refuse with: the operation's @errors.",
                    $"operation \"{op.Name}\" errors", errors.Select(e => (e, $"error \"{e}\"")));
            }
        }
    }

    // ---- the shell's codes ----------------------------------------------------------------------

    /// <summary>The run-wide <c>RuleErrorCodes.g.cs</c> file, in the run's root namespace.</summary>
    protected virtual EmittedFile? RenderShellErrors(GenContext ctx)
    {
        const string cls = "RuleErrorCodes";
        var w = NewWriter();
        WriteFileHeader(w);
        w.Blank();
        w.Line($"namespace {ctx.Config.Namespace};");
        w.Blank();
        w.DocSummary("GENERATED — the wire error codes the enforcing shell answers on its own (ADR-0066 §6). " +
                     "A declared @errors code may not be one of these.");
        using (w.Braced($"public static class {cls}"))
        {
            var members = new Members("shell error codes");
            foreach (var code in SHELL_ERROR_CODES) Const(w, members.Add(Ident(code), $"error \"{code}\""), code);
        }
        return new EmittedFile(cls + ".g.cs", w.ToString());
    }

    // ---- pieces ---------------------------------------------------------------------------------
    // One overridable method each (ADR-0063 item 7). Not a stability contract.

    /// <summary>The writer the file is written on.</summary>
    protected virtual CsWriter NewWriter() => new();

    /// <summary>The generated-file marker and the nullable context.</summary>
    protected virtual void WriteFileHeader(CsWriter w) => w.GeneratedFileHeader("rules-names-generator");

    /// <summary>The namespace a node's file is written in: its package's binding, claimed for the class.</summary>
    protected virtual string Namespace(GenContext ctx, MetaData node, string cls)
    {
        var ns = PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(node), node.Name, fallbackContext: node.Name);
        ctx.Claim($"the C# namespace {ns}", cls, node.ResolutionKey(),
            "map the packages to distinct namespaces (csharp.packageNamespaces, or GenConfig.PackageNamespaces), or rename one");
        return ns;
    }

    private static void WriteGroup(CsWriter w, string cls, string doc, string scope, IEnumerable<(string Value, string Node)> values)
    {
        var members = new Members(scope);
        w.DocSummary(doc);
        using (w.Braced($"public static class {cls}"))
        {
            foreach (var (value, node) in values) Const(w, members.Add(Ident(value), node), value);
        }
    }

    private static void Const(CsWriter w, string name, string value) =>
        w.Line($"public const string {name} = {Literal(value)};");

    private static string Literal(string value) => $"\"{CSharpNaming.CSharpStringLiteral(value)}\"";

    /// <summary>The C# member a metadata name becomes: <c>over_budget</c> → <c>OverBudget</c>,
    /// <c>draft</c> → <c>Draft</c>. A leading digit, which no rules name can start with today, is guarded.</summary>
    protected static string Ident(string name)
    {
        var token = CSharpNaming.PascalToken(name);
        return char.IsDigit(token[0]) ? "_" + token : token;
    }

    /// <summary>
    /// The members of one class, so two metadata names that fold to one C# member (<c>in_review</c> and
    /// <c>inReview</c>) are refused naming both, instead of a file that does not compile.
    /// </summary>
    private sealed class Members(string scope)
    {
        private readonly Dictionary<string, string> _seen = new(StringComparer.Ordinal);

        public string Add(string member, string node)
        {
            if (_seen.TryGetValue(member, out var first))
                throw new InvalidOperationException(
                    $"rules-names: {scope}: {first} and {node} both become the C# member \"{member}\". Rename one.");
            _seen[member] = node;
            return member;
        }
    }
}
