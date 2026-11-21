// The language-neutral code writer (ADR-0063; contract: spec/code-writer.md).
//
// A generator says WHAT a line contains; the writer decides WHERE it sits. It builds the file in
// memory and returns a string, so nothing here touches the disk and no formatter ever runs over
// the result. It never parses the text it is handed: it lays out the structure the generator gave
// it — lines, blocks, blank-line requests and breakable lists.
//
// This module and the dialect beside it are the ONLY codegen source allowed to type layout
// (newlines, indentation). The layout ratchet (MetaObjects.Codegen.Tests/LayoutRatchet) holds
// every other generator file to that.

using System.Text;
using System.Text.RegularExpressions;

namespace MetaObjects.Codegen.Writer;

/// <summary>Error codes a writer throws. Shared by every port's writer (spec/code-writer.md).</summary>
public static class WriterErrors
{
    /// <summary><c>Close()</c> with no block open.</summary>
    public const string UnbalancedClose = "ERR_WRITER_UNBALANCED_CLOSE";
    /// <summary>The file was finished with a block still open; the message quotes the line that opened it.</summary>
    public const string UnclosedBlock = "ERR_WRITER_UNCLOSED_BLOCK";
    /// <summary><c>Line()</c> was handed text containing a line break.</summary>
    public const string NewlineInLine = "ERR_WRITER_NEWLINE_IN_LINE";
    /// <summary>One local name imported from two different places.</summary>
    public const string ImportConflict = "ERR_WRITER_IMPORT_CONFLICT";
}

/// <summary>A writer error: one of the <see cref="WriterErrors"/> codes and a message for people.</summary>
public sealed class WriterException : InvalidOperationException
{
    public string Code { get; }

    public WriterException(string code, string message) : base($"{code}: {message}") => Code = code;
}

/// <summary>
/// An expression fragment: text, a breakable list, or a concatenation of fragments. A
/// <see cref="string"/> converts to one implicitly, so a line is written
/// <c>w.Line("var x = ", w.List("(", args, ")"), ";")</c>.
/// </summary>
public abstract class Piece
{
    public static implicit operator Piece(string text) => new Text(text);

    /// <summary>A list with no padding inside its brackets: <c>[a, b]</c>, <c>f(a, b)</c>, <c>&lt;A, B&gt;</c>.</summary>
    public static Piece List(string open, IEnumerable<Piece> items, string close) => new Group(open, items, close);

    /// <summary>A list padded inside its brackets when it stays on one line: <c>{ a, b }</c>.</summary>
    public static Piece Padded(string open, IEnumerable<Piece> items, string close) => new Group(open, items, close, pad: true);

    /// <summary>Several parts of one line, concatenated.</summary>
    public static Piece Seq(params Piece[] parts) => new Sequence(parts);

    /// <summary>The piece printed on one line.</summary>
    public string Flat()
    {
        var sb = new StringBuilder();
        FlatInto(sb);
        return sb.ToString();
    }

    internal abstract void FlatInto(StringBuilder sb);

    internal sealed class Text(string value) : Piece
    {
        public string Value { get; } = value;
        internal override void FlatInto(StringBuilder sb) => sb.Append(Value);
    }

    internal sealed class Sequence(IReadOnlyList<Piece> parts) : Piece
    {
        public IReadOnlyList<Piece> Parts { get; } = parts;
        internal override void FlatInto(StringBuilder sb)
        {
            foreach (var p in Parts) p.FlatInto(sb);
        }
    }
}

/// <summary>
/// A bracketed, comma-separated list. Printed on one line when the line fits the width; otherwise
/// opener, one item per line (each followed by a comma) and closer.
/// </summary>
public sealed class Group : Piece
{
    public string Open { get; }
    public IReadOnlyList<Piece> Items { get; }
    public string Close { get; }
    /// <summary><c>{ a, b }</c> (true) versus <c>[a, b]</c> or <c>f(a, b)</c> (false) when printed on one line.</summary>
    public bool Pad { get; }

    public Group(string open, IEnumerable<Piece> items, string close, bool pad = false)
    {
        Open = open;
        Items = items.ToList();
        Close = close;
        Pad = pad;
    }

    internal override void FlatInto(StringBuilder sb)
    {
        sb.Append(Open);
        if (Items.Count > 0)
        {
            if (Pad) sb.Append(' ');
            for (var n = 0; n < Items.Count; n++)
            {
                if (n > 0) sb.Append(", ");
                Items[n].FlatInto(sb);
            }
            if (Pad) sb.Append(' ');
        }
        sb.Append(Close);
    }
}

/// <summary>The three options of the core contract. A dialect sets the defaults for its language.</summary>
public sealed record CodeWriterOptions
{
    /// <summary>One level of indentation.</summary>
    public string Indent { get; init; } = "    ";
    /// <summary>The column a line may reach before its last list breaks, in Unicode code points.</summary>
    public int Width { get; init; } = 120;
    /// <summary>Whether a broken list puts a comma after its last item too.</summary>
    public bool TrailingComma { get; init; } = true;
}

/// <summary>
/// The core writer. Built to be extended (ADR-0063): every method is public or protected, so a
/// dialect or an adopter's subclass overrides the one step it needs to change, such as where a line
/// breaks (<see cref="BreakAt"/>) or whether it fits (<see cref="Fits"/>). These methods are not a
/// stability contract and may change between minor versions.
/// </summary>
public class CodeWriter
{
    private static readonly Regex AnyLineBreak = new("\r\n?|\n", RegexOptions.Compiled);

    public string Indent { get; }
    public int Width { get; }
    public bool TrailingComma { get; }

    protected readonly List<string> Out = [];
    /// <summary>The text of each line that opened a block still open, outermost first.</summary>
    protected readonly List<string> Openers = [];
    private readonly List<string> _prefixes = [""];
    protected bool WantBlank;
    /// <summary>True at the start of the file and right after a block opens: no blank line goes here.</summary>
    protected bool AtBlockStart = true;

    public CodeWriter() : this(new CodeWriterOptions()) { }

    public CodeWriter(CodeWriterOptions options)
    {
        Indent = options.Indent;
        Width = options.Width;
        TrailingComma = options.TrailingComma;
    }

    /// <summary>
    /// One line at the current indent. The parts are concatenated; when the line does not fit the
    /// width, the LAST non-empty list in it is printed one item per line. A line whose text is empty
    /// is a blank-line request.
    /// </summary>
    public CodeWriter Line(params Piece[] parts) => Put(Piece.Seq(parts));

    /// <summary>Ask for one blank line before whatever is written next. Requests never stack.</summary>
    public CodeWriter Blank()
    {
        WantBlank = true;
        return this;
    }

    /// <summary>Write the line that opens a block, then indent.</summary>
    public CodeWriter Open(params Piece[] parts) => OpenPiece(Piece.Seq(parts));

    /// <summary>Dedent, then write the line that closes the block.</summary>
    public CodeWriter Close(params Piece[] parts) => ClosePiece(Piece.Seq(parts));

    /// <summary>
    /// <c>Open(head)</c>, then (on dispose) <c>Close(tail)</c>: the indent cannot be left
    /// unbalanced. Used as <c>using (w.Block("if (x) {"))</c>; the head carries its own opening
    /// brace, and <c>tail</c> is the closing line (<c>}</c> by default). A dialect adds the form
    /// its language writes (<see cref="CsWriter.Braced"/> puts the brace on its own line).
    /// </summary>
    public IDisposable Block(Piece head, string tail = "}")
    {
        Open(head);
        return new Scope(() => Close(tail));
    }

    /// <summary>
    /// A multi-line snippet written as it should read. Its common left margin is removed and it is
    /// re-indented to the current level; a blank line in it is a blank-line request. Every line is
    /// re-indented, including lines inside a multi-line string literal.
    /// </summary>
    public CodeWriter Text(string snippet)
    {
        var lines = AnyLineBreak.Split(snippet).ToList();
        if (lines.Count > 1 && lines[0].Trim().Length == 0) lines.RemoveAt(0);
        if (lines.Count > 0 && lines[^1].Trim().Length == 0) lines.RemoveAt(lines.Count - 1);
        var margin = int.MaxValue;
        foreach (var l in lines)
        {
            if (l.Trim().Length != 0) margin = Math.Min(margin, l.Length - l.TrimStart().Length);
        }
        foreach (var l in lines)
        {
            if (l.Trim().Length == 0) Blank();
            else Put(l[margin..]);
        }
        return this;
    }

    /// <summary>The body text: every line joined, with no final newline. Throws if a block is still open.</summary>
    protected virtual string Body()
    {
        if (Openers.Count > 0)
            throw new WriterException(WriterErrors.UnclosedBlock, $"unclosed block opened by: {Openers[^1]}");
        return string.Join('\n', Out);
    }

    /// <summary>The finished file: <c>\n</c> line endings, no trailing whitespace, one final newline (none when empty).</summary>
    public override string ToString()
    {
        var body = Body();
        return body.Length == 0 ? "" : body + '\n';
    }

    /// <summary>Whether <paramref name="text"/> fits on one line at the current indent.</summary>
    protected virtual bool Fits(string text) => WidthOf(Prefix()) + WidthOf(text) <= Width;

    /// <summary>
    /// Where a line that does not fit breaks: the text before, the list that breaks, and the text
    /// after; or null to print the line as it is. The default is the line's LAST non-empty list.
    /// </summary>
    protected virtual (string Before, Group List, string After)? BreakAt(Piece piece) => LastGroup(piece);

    protected CodeWriter OpenPiece(Piece piece)
    {
        Put(piece);
        Openers.Add(piece.Flat().Trim());
        AtBlockStart = true;
        return this;
    }

    protected CodeWriter ClosePiece(Piece piece)
    {
        if (Openers.Count == 0)
            throw new WriterException(WriterErrors.UnbalancedClose, $"Close(\"{piece.Flat()}\") with no block open");
        Openers.RemoveAt(Openers.Count - 1);
        WantBlank = false;
        return Put(piece);
    }

    protected string Prefix()
    {
        var depth = Openers.Count;
        while (_prefixes.Count <= depth) _prefixes.Add(_prefixes[^1] + Indent);
        return _prefixes[depth];
    }

    protected CodeWriter Put(Piece piece)
    {
        var raw = piece.Flat();
        if (AnyLineBreak.IsMatch(raw))
            throw new WriterException(WriterErrors.NewlineInLine,
                $"line text contains a line break; write each line separately or use Text(): \"{raw.Replace("\r", "\\r").Replace("\n", "\\n")}\"");
        var text = raw.TrimEnd();
        if (text.Length == 0) return Blank();
        if (WantBlank && !AtBlockStart) Out.Add("");
        WantBlank = false;
        AtBlockStart = false;
        var pre = Prefix();
        var split = Fits(text) ? null : BreakAt(piece);
        if (split is null)
        {
            Out.Add(pre + text);
            return this;
        }
        var (before, group, after) = split.Value;
        OpenPiece(before + group.Open);
        for (var n = 0; n < group.Items.Count; n++)
        {
            var comma = n < group.Items.Count - 1 || TrailingComma ? "," : "";
            Put(Piece.Seq(group.Items[n], comma));
        }
        return ClosePiece(group.Close + after);
    }

    /// <summary>Character width of <paramref name="s"/>, in Unicode code points.</summary>
    protected static int WidthOf(string s)
    {
        var width = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++;
            width++;
        }
        return width;
    }

    /// <summary>Split a piece around its LAST non-empty list: text before, the list, text after.</summary>
    protected static (string Before, Group List, string After)? LastGroup(Piece p)
    {
        switch (p)
        {
            case Group g:
                return g.Items.Count == 0 ? null : ("", g, "");
            case Piece.Sequence seq:
                for (var i = seq.Parts.Count - 1; i >= 0; i--)
                {
                    if (LastGroup(seq.Parts[i]) is not { } hit) continue;
                    var head = new StringBuilder();
                    for (var k = 0; k < i; k++) seq.Parts[k].FlatInto(head);
                    var tail = new StringBuilder(hit.After);
                    for (var k = i + 1; k < seq.Parts.Count; k++) seq.Parts[k].FlatInto(tail);
                    return (head.ToString() + hit.Before, hit.List, tail.ToString());
                }
                return null;
            default:
                return null;
        }
    }

    private sealed class Scope(Action onDispose) : IDisposable
    {
        private bool _done;

        public void Dispose()
        {
            if (_done) return;
            _done = true;
            onDispose();
        }
    }
}
