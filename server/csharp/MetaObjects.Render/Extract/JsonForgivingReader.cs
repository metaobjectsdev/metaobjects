namespace MetaObjects.Render.Extract;

/// <summary>
/// Stage-4 tolerant JSON reader for the bounded corpus malformation set. Never throws.
/// </summary>
public sealed class JsonForgivingReader
{
    /// <summary>
    /// Sentinel: a key appeared in the text but its value was empty/cut-off (present-but-garbled).
    /// The extract stage uses this to classify the field as MALFORMED rather than omitting it.
    /// </summary>
    public static readonly object Truncated = new();

    /// <summary>
    /// Sentinel: the JSON <c>null</c> literal. Distinct from a C# <c>null</c> return (which this
    /// reader uses internally for "no token / garbled") and from the 4-char string <c>"null"</c>.
    /// The extract phase maps this to an actual null field value (JSON null → null), instead of
    /// letting the bare <c>null</c> literal leak through as the text <c>"null"</c>.
    /// </summary>
    public static readonly object NullLiteral = new();

    private string _s = "";
    private int _i;

    /// <summary>
    /// Parses <paramref name="span"/> as a forgiving JSON object.
    /// Returns a <see cref="Dictionary{String, Object}"/> where values are
    /// <c>string</c>, nested <see cref="Dictionary{String, Object}"/>, <see cref="List{Object}"/>,
    /// or <see cref="Truncated"/> for present-but-cut-off values.
    /// Returns an empty dictionary for unextractable garbage or a non-object root.
    /// </summary>
    public Dictionary<string, object?> Read(string? span)
    {
        _s = span ?? "";
        _i = 0;
        Ws();
        if (_i >= _s.Length || _s[_i] != '{') return new Dictionary<string, object?>();
        object? o = ReadValue();
        return o is Dictionary<string, object?> m ? m : new Dictionary<string, object?>();
    }

    private object? ReadValue()
    {
        Ws();
        if (_i >= _s.Length) return null;
        char c = _s[_i];
        if (c == '{') return ReadObject();
        if (c == '[') return ReadArray();
        if (c is '"' or '\'') return ReadString(c);
        return ReadBareScalar();
    }

    private Dictionary<string, object?> ReadObject()
    {
        var m = new Dictionary<string, object?>();
        _i++; // consume '{'
        while (true)
        {
            Ws();
            if (_i >= _s.Length) return m;             // truncation
            if (_s[_i] == '}') { _i++; return m; }
            string? key = ReadKey();
            if (key == null) return m;                  // truncation mid-key
            Ws();
            if (_i >= _s.Length || _s[_i] != ':') return m; // truncation before value
            _i++; // consume ':'
            Ws();
            if (_i >= _s.Length) { m[key] = Truncated; return m; } // value cut off at EOF → present-but-garbled
            object? v = ReadValue();
            if (v == null)
            {
                // present key, empty/zero-width value → present-but-garbled
                m[key] = Truncated;
                Ws();
                if (_i < _s.Length && _s[_i] == ',') { _i++; continue; }
                if (_i < _s.Length && _s[_i] == '}') { _i++; }
                return m;
            }
            m[key] = v;
            Ws();
            if (_i < _s.Length && _s[_i] == ',') _i++; // optional/trailing comma
        }
    }

    private List<object?> ReadArray()
    {
        var xs = new List<object?>();
        _i++; // consume '['
        while (true)
        {
            Ws();
            if (_i >= _s.Length) return xs;
            if (_s[_i] == ']') { _i++; return xs; }
            if (_s[_i] == '}') { _i++; return xs; }   // malformed brace-close terminates array
            object? v = ReadValue();
            if (v == null)
            {
                // zero-width / no value → stop (no spin)
                Ws();
                if (_i < _s.Length && (_s[_i] == ']' || _s[_i] == '}')) _i++;
                return xs;
            }
            xs.Add(v);
            Ws();
            if (_i < _s.Length && _s[_i] == ',') _i++;
            else if (_i < _s.Length && _s[_i] == ']') { _i++; return xs; }
            else return xs; // EOF or any other non-separator char → stop
        }
    }

    private string? ReadKey()
    {
        Ws();
        if (_i >= _s.Length) return null;
        char c = _s[_i];
        if (c is '"' or '\'') return ReadString(c);
        int start = _i;
        while (_i < _s.Length && (char.IsLetterOrDigit(_s[_i]) || _s[_i] == '_')) _i++;
        return _i > start ? _s[start.._i] : null;
    }

    private string ReadString(char quote)
    {
        _i++; // opening quote
        var sb = new System.Text.StringBuilder();
        bool esc = false;
        while (_i < _s.Length)
        {
            char c = _s[_i++];
            if (esc) { sb.Append(Unescape(c)); esc = false; }
            else if (c == '\\') esc = true;
            else if (c == quote) return sb.ToString();
            else sb.Append(c);
        }
        return sb.ToString(); // unterminated string → return what we have
    }

    private static char Unescape(char c) => c switch
    {
        'n' => '\n',
        't' => '\t',
        'r' => '\r',
        _ => c
    };

    private object? ReadBareScalar()
    {
        int start = _i;
        // A comment after an unquoted value (`7 // good`) ends it; `http://x` does not.
        while (_i < _s.Length && ",}]".IndexOf(_s[_i]) < 0
               && !(_i > start && char.IsWhiteSpace(_s[_i - 1]) && CommentOpensAt(_s, _i))) _i++;
        string result = _s[start.._i].Trim();
        if (result.Length == 0) return null;            // no token read (zero-width)
        if (result == "null") return NullLiteral;       // JSON null literal → explicit null, NOT the string "null"
        return result;
    }

    /// <summary>Skip whitespace AND <c>//</c> / <c>/* */</c> comments. Only ever called between
    /// tokens, so a comment marker inside a string literal is never reached here.</summary>
    private void Ws()
    {
        while (true)
        {
            while (_i < _s.Length && char.IsWhiteSpace(_s[_i])) _i++;
            int end = CommentEnd(_s, _i);
            if (end < 0) return;
            _i = end;
        }
    }

    /// <summary>True when a <c>//</c> or <c>/*</c> comment opens at <paramref name="at"/>.</summary>
    internal static bool CommentOpensAt(string s, int at) =>
        at + 1 < s.Length && s[at] == '/' && (s[at + 1] == '/' || s[at + 1] == '*');

    /// <summary>
    /// Models write JSONC: <c>{"score": 7, // good</c> drops every field after it in a strict
    /// reader. When a comment opens at <paramref name="at"/>, the index just past it (a line
    /// comment runs to the end of its line, a block comment to its close or the end of the
    /// text); otherwise -1.
    /// </summary>
    internal static int CommentEnd(string s, int at)
    {
        if (!CommentOpensAt(s, at)) return -1;
        if (s[at + 1] == '/')
        {
            int j = at + 2;
            while (j < s.Length && s[j] != '\n' && s[j] != '\r') j++;
            return j;
        }
        int close = s.IndexOf("*/", at + 2, StringComparison.Ordinal);
        return close < 0 ? s.Length : close + 2;
    }
}
