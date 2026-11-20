// ADR-0066 — the project settings the business-rules vocabulary reads, from the `rules`
// and `verify` blocks of `.metaobjects/config.json`. Every port reads the same keys with
// the same defaults. A key that is absent takes its default, which is always the
// behaviour a project had before the setting existed. Mirrors
// server/typescript/packages/metadata/src/rules-settings.ts.

namespace MetaObjects.Config;

/// <summary>The resolved settings, every absent key at its default. Each value is the
/// lower-case spelling the config uses.</summary>
/// <param name="PermissionNames"><c>rules.permissions.names</c>: <c>derive</c> (default), <c>advise</c>, <c>require</c>.</param>
/// <param name="LifecycleCreate"><c>rules.lifecycle.create</c>: <c>initial</c> (default) or <c>any</c>. Read and validated; changes nothing yet.</param>
/// <param name="LifecycleCommands"><c>rules.lifecycle.commands</c>: <c>unclaimed</c> (default), <c>all</c>, <c>none</c>.</param>
/// <param name="LifecycleUnreachable"><c>verify.lifecycle.unreachable</c>: <c>warn</c> (default), <c>error</c>, <c>off</c>.</param>
public sealed record RulesSettings(
    string PermissionNames = "derive",
    string LifecycleCreate = "initial",
    string LifecycleCommands = "unclaimed",
    string LifecycleUnreachable = "warn")
{
    public static readonly string[] PermissionNameValues = ["derive", "advise", "require"];
    public static readonly string[] LifecycleCreateValues = ["initial", "any"];
    public static readonly string[] LifecycleCommandsValues = ["unclaimed", "all", "none"];
    public static readonly string[] LifecycleUnreachableValues = ["warn", "error", "off"];

    /// <summary>Every key at its default.</summary>
    public static readonly RulesSettings Default = new();
}
