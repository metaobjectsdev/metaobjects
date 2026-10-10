// ScenarioEngine — the database engine a query scenario runs against. Postgres is the
// reference; SQLite and MySQL are the other engines the FR-044 report scenarios run on in C#.

using System.Text;
using System.Text.RegularExpressions;

namespace MetaObjects.IntegrationTests.Runner;

public enum ScenarioEngine
{
    Postgres,
    Sqlite,
    MySql,
}

public static class ScenarioEngineExtensions
{
    /// <summary>The engine's name as the corpus spells it (the key of a <c>seed-data-engine</c> entry).</summary>
    public static string Name(this ScenarioEngine engine) => engine switch
    {
        ScenarioEngine.Postgres => "postgres",
        ScenarioEngine.Sqlite => "sqlite",
        ScenarioEngine.MySql => "mysql",
        _ => throw new ArgumentOutOfRangeException(nameof(engine), engine, null),
    };
}

public static partial class MySqlSeed
{
    [GeneratedRegex(@"'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z'")]
    private static partial Regex UtcInstant();

    /// <summary>
    /// Postgres-quoted seed SQL to MySQL. Walks the text once so a double quote INSIDE a
    /// single-quoted string (a JSON payload) is left alone and only a double-quoted identifier
    /// becomes a backtick one; a UTC instant literal loses its <c>Z</c> (a DATETIME holds the UTC
    /// wall clock). ANSI_QUOTES stays off: it would change how the view bodies parse.
    /// </summary>
    public static string FromPostgres(string seed)
    {
        var sb = new StringBuilder(seed.Length);
        bool inString = false, inIdent = false;
        for (var i = 0; i < seed.Length; i++)
        {
            var c = seed[i];
            if (inString)
            {
                sb.Append(c);
                if (c == '\'')
                {
                    if (i + 1 < seed.Length && seed[i + 1] == '\'') { sb.Append('\''); i++; }
                    else inString = false;
                }
            }
            else if (inIdent)
            {
                if (c == '"') { sb.Append('`'); inIdent = false; } else sb.Append(c);
            }
            else if (c == '\'') { inString = true; sb.Append(c); }
            else if (c == '"') { inIdent = true; sb.Append('`'); }
            else sb.Append(c);
        }
        return UtcInstant().Replace(sb.ToString(), "'$1'");
    }
}
