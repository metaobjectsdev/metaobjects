// Which template engines this port renders (ADR-0061). Mustache is the cross-port engine
// and the only one the C# port ships. Jinja is a second engine that only the Python and
// TypeScript ports render, chosen there by a .jinja / .j2 / .jinja2 file extension. A
// provider here that meets a body written for Jinja refuses it by name, rather than
// rendering it as Mustache (which would print its {% %} tags verbatim) or reporting the
// ref as missing.

namespace MetaObjects.Render;

public static class TemplateEngines
{
    /// <summary>The diagnostic code for a body written for an engine this port does not ship.</summary>
    public const string ErrTemplateEngineUnsupported = "ERR_TEMPLATE_ENGINE_UNSUPPORTED";

    /// <summary>File extensions that mark a body as Jinja, in the Python and TypeScript lookup order.</summary>
    public static readonly IReadOnlyList<string> JinjaExtensions = [".jinja", ".j2", ".jinja2"];

    /// <summary>True when <paramref name="extension"/> (with its leading dot) marks a Jinja body.</summary>
    public static bool IsJinjaExtension(string extension) =>
        JinjaExtensions.Contains(extension.ToLowerInvariant());

    /// <summary>True when <paramref name="e"/> is this refusal (its message starts with the code).</summary>
    public static bool IsEngineRefusal(RenderException e) =>
        e.Message.StartsWith(ErrTemplateEngineUnsupported, StringComparison.Ordinal);

    internal static void RefuseJinjaExtension(string extension)
    {
        if (IsJinjaExtension(extension))
            throw new RenderException(
                $"{ErrTemplateEngineUnsupported}: {extension} templates are Jinja, which only the Python and TypeScript ports render (ADR-0061)");
    }

    internal static void RefuseJinjaSibling(string reference, Func<string, bool> exists)
    {
        foreach (var ext in JinjaExtensions)
        {
            if (exists(ext))
                throw new RenderException(
                    $"{ErrTemplateEngineUnsupported}: {reference}{ext} is a Jinja template; the C# port renders Mustache only (ADR-0061)."
                    + $" Rewrite it as {reference}.mustache, or render it from the Python or TypeScript port.");
        }
    }
}
