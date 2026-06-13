// Renders the CSharpApiModel IR into C#-idiomatic api-doc markdown.
//
// One IR, three forms — all derived from the SAME model, never re-derived:
//   • RenderUnitPage  — a per-unit HUMAN page (entity OR template), symbols grouped
//                        into ordered sections + the **Model / metadata:** back-link.
//   • RenderIndex     — the consolidated index (README.md), one bullet per unit.
//   • RenderAgentApi  — the token-frugal AGENT form (AGENT-API.md), symbols grouped
//                        under their namespace.
//
// PRESENTATION ONLY: every symbol name comes from the IR (which keys off the
// CSharpNaming seam) and every path comes from DocsPaths — the renderer never
// re-derives a name or a path. The section order + headings + the back-link literal
// mirror the Java JavaApiDocsRenderer so the polyglot doc tree coheres.

using System.Text;

namespace MetaObjects.Codegen.ApiDocs;

/// <summary>Renders <see cref="CSharpApiModel"/> into per-unit / index / agent markdown.</summary>
public sealed class CSharpApiDocsRenderer
{
    // Canonical section order per kind (a unit renders only the kinds it carries).
    private static readonly ApiSymbolKind[] KindOrder =
    {
        ApiSymbolKind.Model,
        ApiSymbolKind.DataAccess,
        ApiSymbolKind.Rest,
        ApiSymbolKind.Validation,
        ApiSymbolKind.Extractor,
        ApiSymbolKind.Render,
        ApiSymbolKind.Payload,
        ApiSymbolKind.Prompt,
        ApiSymbolKind.OutputParser,
        ApiSymbolKind.Filter,
    };

    private static string Heading(ApiSymbolKind k) => k switch
    {
        ApiSymbolKind.Model => "Model",
        ApiSymbolKind.DataAccess => "Data access",
        ApiSymbolKind.Rest => "REST",
        ApiSymbolKind.Validation => "Validation",
        ApiSymbolKind.Extractor => "Extractor",
        ApiSymbolKind.Render => "Render",
        ApiSymbolKind.Payload => "Payload",
        ApiSymbolKind.Prompt => "Prompt",
        ApiSymbolKind.OutputParser => "Output parser",
        ApiSymbolKind.Filter => "Filter",
        _ => throw new ArgumentOutOfRangeException(nameof(k), k, "unmapped kind"),
    };

    private static string SummaryLabel(ApiSymbolKind k) => k switch
    {
        ApiSymbolKind.Model => "model",
        ApiSymbolKind.DataAccess => "data access",
        ApiSymbolKind.Rest => "REST",
        ApiSymbolKind.Validation => "validation",
        ApiSymbolKind.Extractor => "extractor",
        ApiSymbolKind.Render => "render",
        ApiSymbolKind.Payload => "payload",
        ApiSymbolKind.Prompt => "prompt",
        ApiSymbolKind.OutputParser => "output parser",
        ApiSymbolKind.Filter => "filter",
        _ => throw new ArgumentOutOfRangeException(nameof(k), k, "unmapped kind"),
    };

    // ------------------------------------------------------------------------
    // Per-unit HUMAN page.
    // ------------------------------------------------------------------------

    /// <summary>
    /// Render one per-unit human reference page. <paramref name="modelHref"/> (when
    /// non-null/empty) is a pre-computed relative href back to this unit's model/metadata
    /// page — the caller derives it via <see cref="DocsPaths.ModelCrossHref"/>; the
    /// renderer only places it (as the contract <c>**Model / metadata:**</c> back-link).
    /// </summary>
    public string RenderUnitPage(ApiUnit unit, string? modelHref)
    {
        var sb = new StringBuilder();
        sb.Append("# ").Append(unit.Node).Append(" API\n");
        if (!string.IsNullOrEmpty(modelHref))
            sb.Append("\n**Model / metadata:** [").Append(unit.Node).Append("](").Append(modelHref).Append(")\n");
        sb.Append("\n> Namespaces are fully-qualified; reference the generated assembly in your project.\n");

        foreach (var kind in KindOrder)
        {
            var syms = unit.Symbols.Where(s => s.Kind == kind).ToList();
            if (syms.Count == 0) continue;
            sb.Append("\n## ").Append(Heading(kind)).Append('\n');
            foreach (var sym in syms)
            {
                sb.Append("\n### `").Append(sym.Signature).Append("`\n");
                sb.Append('\n').Append(sym.Usage).Append('\n');
                // A real, valid C# snippet: the `using <Namespace>;` directive an adopter
                // writes to reach this symbol (mirrors Python's `from .x import Y` import
                // line). NOT the bare namespace string.
                sb.Append("\n```csharp\nusing ").Append(sym.Namespace).Append(";\n```\n");
                if (!string.IsNullOrEmpty(sym.Returns))
                    sb.Append("\nReturns: ").Append(sym.Returns).Append('\n');
                if (sym.FieldList.Count > 0)
                {
                    sb.Append("\n| Field | Type | Required | Notes |\n|---|---|---|---|\n");
                    foreach (var f in sym.FieldList)
                        sb.Append("| `").Append(f.Name).Append("` | `").Append(MdCell(f.Type))
                          .Append("` | ").Append(f.Optional ? "no" : "yes").Append(" | ")
                          .Append(MdCell(f.Note ?? "")).Append(" |\n");
                }
            }
        }
        return sb.ToString();
    }

    private static string MdCell(string text) => text.Replace("|", "\\|");

    // ------------------------------------------------------------------------
    // Consolidated index (README.md).
    // ------------------------------------------------------------------------

    /// <summary>
    /// Render the consolidated api index (one bullet per unit, entities/values vs
    /// templates), at the api root (<c>README.md</c>). Each unit's href is the relative
    /// link from the index to the unit's page in the given <paramref name="layout"/>.
    /// </summary>
    public string RenderIndex(CSharpApiModel model, DocsPaths.Layout layout)
    {
        var entities = model.Units.Where(u => u.Kind != "template").OrderBy(u => u.Node, StringComparer.Ordinal).ToList();
        var templates = model.Units.Where(u => u.Kind == "template").OrderBy(u => u.Node, StringComparer.Ordinal).ToList();

        var sb = new StringBuilder();
        sb.Append("# API Reference\n\nGenerated public API surface, one page per entity and output template.\n");
        if (entities.Count > 0)
        {
            sb.Append("\n## Entities\n\n");
            foreach (var u in entities) AppendIndexRow(sb, u, layout);
        }
        if (templates.Count > 0)
        {
            sb.Append("\n## Templates\n\n");
            foreach (var u in templates) AppendIndexRow(sb, u, layout);
        }
        return sb.ToString();
    }

    private void AppendIndexRow(StringBuilder sb, ApiUnit u, DocsPaths.Layout layout)
    {
        var href = DocsPaths.SurfaceCrossHref("README.md", DocsPaths.DocPageOutputPath(layout, u.Package, u.Node));
        sb.Append("- [").Append(u.Node).Append("](").Append(href).Append(") — ")
          .Append(Summary(u)).Append(" (").Append(u.Symbols.Count).Append(" symbols)\n");
    }

    private static string Summary(ApiUnit unit)
    {
        var parts = new List<string>();
        foreach (var kind in KindOrder)
        {
            var n = unit.Symbols.Count(s => s.Kind == kind);
            if (n == 0) continue;
            var label = SummaryLabel(kind);
            parts.Add(n == 1 ? label : $"{n} {label}");
        }
        return parts.Count == 0 ? "no public symbols" : string.Join(", ", parts);
    }

    // ------------------------------------------------------------------------
    // Condensed AGENT form (AGENT-API.md).
    // ------------------------------------------------------------------------

    /// <summary>
    /// Render the condensed agent/LLM form: per unit, symbols grouped under a single
    /// namespace header then one compact <c>`signature` — usage</c> line each. NO
    /// prose/field-tables (token budget). Units + symbols keep their IR order.
    /// </summary>
    public string RenderAgentApi(CSharpApiModel model)
    {
        var sb = new StringBuilder();
        sb.Append("# Agent API Reference\n\nGenerated C# API reference for ").Append(model.Project)
          .Append("; call these exactly as written. Namespaces are fully-qualified in the generated assembly.\n");
        foreach (var u in model.Units)
        {
            if (u.Symbols.Count == 0) continue;
            sb.Append("\n## ").Append(u.Node).Append('\n');
            foreach (var group in u.Symbols.GroupBy(s => s.Namespace))
            {
                // The import line an adopter writes (mirrors Python's `from .x import Y`
                // group header), not the bare namespace.
                sb.Append("\n`using ").Append(group.Key).Append(";`\n");
                foreach (var s in group)
                    sb.Append("- `").Append(s.Signature).Append("` — ").Append(s.Usage).Append('\n');
            }
        }
        return sb.ToString();
    }
}
