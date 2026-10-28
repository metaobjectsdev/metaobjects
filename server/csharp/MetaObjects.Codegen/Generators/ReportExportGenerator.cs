// report-export — the CSV, JSON and XML download of a served report (docs/features/api-contract.md,
// "Report export"; docs/features/reporting.md, "Exporting a report").
//
// Wiring it is listing it: a project that lists this generator in codegen/Generators.cs gets a
// `?format=csv|json|xml` branch on every served report's list route, because the routes generator
// finds a wired report-export in the run's generator list (GenContext.ReportExportMaxRows). A project
// that does not list it gets routes byte-identical to the ones before export existed. It is a
// standalone catalog generator, never implied by a library.
//
// WHAT IT WRITES, into the run's --out:
//   - ReportExportWriter.g.cs  ONE shared writer per project: the CSV writer (RFC 4180, CRLF after
//     every record, the formula-injection guard, the optional BOM) and the XML writer (XmlWriter,
//     no declaration, no indentation, xsi:nil or empty elements), plus the wire-form conversion of
//     a cell (currency as integer minor units, a date as YYYY-MM-DD, a decimal per the project's
//     `wire` setting, a boolean as true/false, a null as an empty cell).
//   - <Report>Export.g.cs      one module per served report: its column list in derived-field order
//     and the two writers over its generated row class.
// The JSON download is not written here: it is the list route's own array through the host's JSON
// options (ReportExportHttp.Json), so a `wire` setting applies to it exactly as to the list route.
//
// The generated code uses StreamWriter-compatible TextWriter, XmlWriter and System.Text.Json only.
// It imports nothing from MetaObjects and adds no package to the adopter's project.
//
// THE FORMULA-INJECTION GUARD applies to string-valued cells only (a string, an enum symbol, a
// uri): a value starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading apostrophe, THEN the cell
// is quoted if it holds `"`, `,`, CR or LF. This is the render escapers' rule (the render-csv-injection
// fixture). A number, decimal, date or boolean is never guarded, so a negative number stays a number.
// XML has no guard.
//
// OPTIONS are public init properties, set where the project declares the generator:
//
//     new ReportExportGenerator { MaxRows = 50_000, XmlNulls = ReportExportXmlNulls.Empty, CsvBom = true }
//
// It is a reference helper (ADR-0034 Amendment 3): `dotnet meta eject report-export` copies this one
// file into your project and you own it.

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>How the XML export writes a null field.</summary>
public enum ReportExportXmlNulls
{
    /// <summary>An empty element carrying <c>xsi:nil="true"</c>, with <c>xmlns:xsi</c> declared on the root.
    /// What <c>XmlSerializer</c> writes for a nullable value type and what <c>DataContractSerializer</c> writes
    /// for any null; it keeps a null apart from an empty string. This is the C# default.</summary>
    Nil,
    /// <summary>An empty element, nothing declared: a null and an empty string read alike.</summary>
    Empty,
}

/// <summary>Generates the CSV and XML export modules of the served reports, and wires <c>?format=</c> into their routes.</summary>
public class ReportExportGenerator : IGenerator
{
    public string Name => "report-export";

    /// <summary>The most rows an export answers; one more, or a <c>limit</c> above it, is
    /// <c>400 export_too_large</c> before a byte is written. Default 100,000.</summary>
    public int MaxRows { get; init; } = DefaultMaxRows;

    /// <summary>The export row cap when none is set, the same default in every port.</summary>
    public const int DefaultMaxRows = 100_000;

    /// <summary>Listing this generator wires the report list routes with <see cref="MaxRows"/> as their export cap.</summary>
    public int? ReportExportMaxRows => MaxRows;

    /// <summary>How a null field is written in XML. Default <see cref="ReportExportXmlNulls.Nil"/>, the C# standard.</summary>
    public ReportExportXmlNulls XmlNulls { get; init; } = ReportExportXmlNulls.Nil;

    /// <summary>Start the CSV with a UTF-8 byte order mark (what Excel wants to read UTF-8). Default false.
    /// Emitted as the constant <c>ReportExportWriter.ExportCsvBom</c>, which you can also flip in the output.</summary>
    public bool CsvBom { get; init; } = false;

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var served = ReportRows.WithReportRows(ctx)
            .Where(e => e.IsReport() && ReportRows.IsViewBacked(e))
            .ToList();
        if (served.Count == 0) yield break;

        yield return new EmittedFile("ReportExportWriter.g.cs", SharedWriter(ctx));
        foreach (var report in served)
            yield return new EmittedFile(CSharpNaming.Pascal(report.Name) + "Export.g.cs", ReportModule(report, ctx));
    }

    private static string Literal(bool b) => b ? "true" : "false";

    private string ReportModule(MetaObject report, GenContext ctx)
    {
        var cls = CSharpNaming.Pascal(report.Name);
        var fields = report.Fields().ToList();
        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects report-export. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine("using System.IO;");
        sb.AppendLine("using System.Linq;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine($"/// <summary>The CSV and XML export of the <c>{report.Name}</c> report: its columns, in derived-field order, over the generated <see cref=\"{cls}\"/> row.</summary>");
        sb.AppendLine($"public static class {cls}Export");
        sb.AppendLine("{");
        sb.AppendLine("    /// <summary>The XML root element.</summary>");
        sb.AppendLine($"    public const string Root = \"{report.Name}\";");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>The derived field names, in derived-field order: the CSV header row and the XML element names.</summary>");
        sb.AppendLine("    public static readonly IReadOnlyList<string> Columns =");
        sb.AppendLine("    [");
        foreach (var f in fields) sb.AppendLine($"        \"{f.Name}\",");
        sb.AppendLine("    ];");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>One row's cells in wire form, in <see cref=\"Columns\"/> order.</summary>");
        sb.AppendLine($"    public static ReportExportCell[] Cells({cls} row) =>");
        sb.AppendLine("    [");
        foreach (var f in fields)
            sb.AppendLine($"        ReportExportWriter.Cell(row.{CSharpNaming.Pascal(f.Name)}),");
        sb.AppendLine("    ];");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Writes the rows as RFC 4180 CSV.</summary>");
        sb.AppendLine($"    public static void WriteCsv(TextWriter writer, IEnumerable<{cls}> rows) =>");
        sb.AppendLine("        ReportExportWriter.WriteCsv(writer, Columns, rows.Select(Cells));");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Writes the rows as XML.</summary>");
        sb.AppendLine($"    public static void WriteXml(TextWriter writer, IEnumerable<{cls}> rows) =>");
        sb.AppendLine("        ReportExportWriter.WriteXml(writer, Root, Columns, rows.Select(Cells));");
        sb.AppendLine("}");
        return sb.ToString();
    }

    private string SharedWriter(GenContext ctx)
    {
        var text = SharedWriterTemplate
            .Replace("@NAMESPACE@", ctx.Config.Namespace, StringComparison.Ordinal)
            .Replace("@CSV_BOM@", Literal(CsvBom), StringComparison.Ordinal)
            .Replace("@DECIMALS_AS_STRING@", Literal(ctx.Root.WireFormat.Decimals == DecimalWireForm.String), StringComparison.Ordinal)
            .Replace("@XML_NIL@", Literal(XmlNulls == ReportExportXmlNulls.Nil), StringComparison.Ordinal);
        return text;
    }

    // The shared writer, verbatim but for the four @TOKENS@. A plain string, not an interpolated
    // one: the C# it holds is full of braces.
    private const string SharedWriterTemplate = """
// <auto-generated/>
// Generated by MetaObjects report-export. Do not edit by hand.
//
// The shared writer of every report export: CSV and XML over cells already in wire form.
#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Xml;

namespace @NAMESPACE@;

/// <summary>One exported cell: its wire-form text (<c>null</c> for a null) and whether the CSV formula-injection guard applies to it.</summary>
public readonly record struct ReportExportCell(string? Value, bool IsText);

/// <summary>CSV and XML writers for a report export, and the wire-form conversion of a cell.</summary>
public static class ReportExportWriter
{
    /// <summary>Start the CSV with a UTF-8 byte order mark. Flip it here, or regenerate with <c>CsvBom = true</c>.</summary>
    public static readonly bool ExportCsvBom = @CSV_BOM@;

    /// <summary>The project's <c>wire.decimals</c> setting: write a decimal as its canonical string (<c>12.5</c>) rather than as System.Text.Json does (<c>12.50</c>).</summary>
    public static readonly bool DecimalsAsString = @DECIMALS_AS_STRING@;

    /// <summary>Write a null field as an empty element carrying <c>xsi:nil="true"</c> (and declare <c>xmlns:xsi</c> on the root) instead of as a bare empty element.</summary>
    public static readonly bool XmlNil = @XML_NIL@;

    private const string XsiNamespace = "http://www.w3.org/2001/XMLSchema-instance";

    /// <summary>The wire form of a row property: currency as integer minor units, a date as <c>YYYY-MM-DD</c>, a timestamp as UTC with <c>Z</c>, a boolean as <c>true</c>/<c>false</c>, a null as null.</summary>
    public static ReportExportCell Cell(object? value)
    {
        switch (value)
        {
            case null: return new(null, false);
            case string s: return new(s, true);
            case bool b: return new(b ? "true" : "false", false);
            case DateOnly d: return new(d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), false);
            case TimeOnly t: return new(t.ToString("HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture), false);
            case DateTimeOffset o: return new(o.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", CultureInfo.InvariantCulture), false);
            case DateTime dt: return new(dt.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture), false);
            case Guid g: return new(g.ToString("D", CultureInfo.InvariantCulture), false);
            case decimal m: return new(DecimalsAsString ? Canonical(m) : m.ToString(CultureInfo.InvariantCulture), false);
            case Enum e: return new(e.ToString(), true);
            case Uri u: return new(u.OriginalString, true);
            case IPAddress ip: return new(ip.ToString(), false);
            case IEnumerable: return new(System.Text.Json.JsonSerializer.Serialize(value), false);
            case IFormattable f: return new(f.ToString(null, CultureInfo.InvariantCulture), false);
            default: return new(Convert.ToString(value, CultureInfo.InvariantCulture), true);
        }
    }

    // The canonical decimal string: plain notation, no trailing fraction zeros, zero as "0".
    private static string Canonical(decimal value)
    {
        var s = value.ToString(CultureInfo.InvariantCulture);
        if (s.IndexOf('.') >= 0)
        {
            s = s.TrimEnd('0');
            if (s.EndsWith('.')) s = s.Substring(0, s.Length - 1);
        }
        return s == "-0" || s.Length == 0 ? "0" : s;
    }

    /// <summary>
    /// Writes RFC 4180 CSV: UTF-8 text, a header row of <paramref name="columns"/>, CRLF after every record
    /// including the last. A cell containing <c>"</c>, <c>,</c>, CR or LF is quoted with embedded quotes doubled.
    /// A string-valued cell starting with <c>=</c>, <c>+</c>, <c>-</c>, <c>@</c>, TAB or CR is prefixed with an
    /// apostrophe first (the formula-injection guard); a number, date or boolean never is. A null is an empty cell.
    /// </summary>
    public static void WriteCsv(TextWriter writer, IReadOnlyList<string> columns, IEnumerable<ReportExportCell[]> rows)
    {
        if (ExportCsvBom) writer.Write('﻿');
        for (var i = 0; i < columns.Count; i++)
        {
            if (i > 0) writer.Write(',');
            writer.Write(CsvQuote(columns[i]));
        }
        writer.Write("\r\n");
        foreach (var row in rows)
        {
            for (var i = 0; i < row.Length; i++)
            {
                if (i > 0) writer.Write(',');
                writer.Write(CsvField(row[i]));
            }
            writer.Write("\r\n");
        }
    }

    /// <summary>One CSV field: the injection guard (text cells only), then the quoting.</summary>
    public static string CsvField(ReportExportCell cell)
    {
        if (cell.Value is not { } value) return "";
        if (cell.IsText && value.Length > 0 && value[0] is '=' or '+' or '-' or '@' or '\t' or '\r')
            value = "'" + value;
        return CsvQuote(value);
    }

    private static string CsvQuote(string value) =>
        value.AsSpan().IndexOfAny("\",\r\n") >= 0 ? "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"" : value;

    /// <summary>
    /// Writes <c>&lt;root&gt;&lt;row&gt;&lt;field&gt;value&lt;/field&gt;...&lt;/row&gt;...&lt;/root&gt;</c>: no XML declaration, no indentation,
    /// text escaped by XmlWriter (<c>&amp; &lt; &gt;</c>, and a CR as a character reference so a parse keeps it).
    /// There is no injection guard in XML. A null follows <see cref="XmlNil"/>. A character XML 1.0 cannot carry
    /// is written as U+FFFD rather than failing the whole export.
    /// </summary>
    public static void WriteXml(TextWriter writer, string root, IReadOnlyList<string> columns, IEnumerable<ReportExportCell[]> rows)
    {
        var settings = new XmlWriterSettings
        {
            OmitXmlDeclaration = true,
            Indent = false,
            NewLineHandling = NewLineHandling.Entitize,
        };
        using var xml = XmlWriter.Create(writer, settings);
        xml.WriteStartElement(root);
        if (XmlNil) xml.WriteAttributeString("xmlns", "xsi", null, XsiNamespace);
        foreach (var row in rows)
        {
            xml.WriteStartElement("row");
            for (var i = 0; i < columns.Count; i++)
            {
                xml.WriteStartElement(columns[i]);
                if (row[i].Value is { } text) xml.WriteString(XmlSafe(text));
                else if (XmlNil) xml.WriteAttributeString("xsi", "nil", XsiNamespace, "true");
                xml.WriteEndElement();
            }
            xml.WriteEndElement();
        }
        xml.WriteEndElement();
    }

    private static string XmlSafe(string text)
    {
        StringBuilder? fixedUp = null;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            var ok = XmlConvert.IsXmlChar(c);
            if (!ok && i + 1 < text.Length && XmlConvert.IsXmlSurrogatePair(text[i + 1], c))
            {
                fixedUp?.Append(c).Append(text[i + 1]);
                i++;
                continue;
            }
            if (ok) { fixedUp?.Append(c); continue; }
            fixedUp ??= new StringBuilder(text.Length).Append(text, 0, i);
            fixedUp.Append('�');
        }
        return fixedUp?.ToString() ?? text;
    }
}
""";
}
