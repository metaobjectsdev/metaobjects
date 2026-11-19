// Warm-load driver for the C# loader.
// usage: LoadBench <model-dir> <timed-loads> [--canonical <out-file>]
using System.Diagnostics;
using MetaObjects;
using MetaObjects.Loader;

var dir = args[0];
var n = int.Parse(args[1]);
var canonicalOut = args.Length > 3 && args[2] == "--canonical" ? args[3] : null;

LoadResult Load()
{
    var r = MetaDataLoader.FromDirectory(dir);
    if (r.Errors.Count > 0) throw new InvalidOperationException($"load errors: {r.Errors[0]}");
    return r;
}

var first = Load(); // warm-up
if (canonicalOut is not null) File.WriteAllText(canonicalOut, SerializerJson.CanonicalSerialize(first.Root));
var times = new List<double>();
for (var i = 0; i < n; i++)
{
    var t0 = Stopwatch.GetTimestamp();
    Load();
    times.Add(Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
}
times.Sort();
var peak = Process.GetCurrentProcess().PeakWorkingSet64 / (1024 * 1024);
Console.WriteLine($"{{\"port\":\"csharp\",\"loads\":{n},\"median_ms\":{times[n / 2]:F1},\"peak_rss_mib\":{peak}}}");
