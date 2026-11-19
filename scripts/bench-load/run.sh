#!/usr/bin/env bash
# Warm-load benchmark: a model N times the fitness model, loaded by each port.
#
# usage: run.sh [--src <repo-root>] [--sizes "1 5 10 20"] [--loads 7] [--ports "typescript python csharp"]
#               [--canonical-dir <dir>]
#
# --src          the checkout to measure (default: this one). Point it at a pristine copy of an
#                older commit to get a "before" row. Its TypeScript metadata package must be
#                built (dist/); the C# library is built here.
# --canonical-dir  also write each port's canonical serialization of the largest model, so two
#                runs can be compared byte for byte.
# Prints one JSON object per (port, size): median warm-load ms, peak RSS MiB, then a table.
# Scratch (the model, the C# build) lives under $DEV_SCRATCH (else the system temp dir).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(cd "$here/../.." && pwd)"
sizes="1 5 10 20"
loads=7
ports="typescript python csharp"
canon=""
while [ $# -gt 0 ]; do
  case "$1" in
    --src) src="$(cd "$2" && pwd)"; shift 2 ;;
    --sizes) sizes="$2"; shift 2 ;;
    --loads) loads="$2"; shift 2 ;;
    --ports) ports="$2"; shift 2 ;;
    --canonical-dir) canon="$2"; mkdir -p "$canon"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d "${DEV_SCRATCH:-${TMPDIR:-/tmp}}/bench-load.XXXXXX")"
trap 'rm -rf "$work"' EXIT
largest="${sizes##* }"

for n in $sizes; do python3 "$here/gen-model.py" "$n" "$work/model-$n"; done

if [[ " $ports " == *" csharp "* ]]; then
  cp "$here/csharp/LoadBench.csproj" "$here/csharp/Program.cs" "$work/"
  (cd "$work" && dotnet build LoadBench.csproj -c Release -o "$work/csharp-out" \
      -p:MetaObjectsProject="$src/server/csharp/MetaObjects/MetaObjects.csproj" \
      -v quiet -nologo >&2)
fi

results="$work/results.jsonl"
: > "$results"
for port in $ports; do
  for n in $sizes; do
    extra=()
    [ -n "$canon" ] && [ "$n" = "$largest" ] && extra=(--canonical "$canon/$port.canonical.json")
    case "$port" in
      typescript) out=$(MO_TS_DIST="$src/server/typescript/packages/metadata/dist" node "$here/ts-load.mjs" "$work/model-$n" "$loads" "${extra[@]}") ;;
      python)     out=$(MO_PY_SRC="$src/server/python/src" python3 -I "$here/py_load.py" "$work/model-$n" "$loads" "${extra[@]}") ;;
      csharp)     out=$(dotnet "$work/csharp-out/LoadBench.dll" "$work/model-$n" "$loads" "${extra[@]}") ;;
    esac
    echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); d['copies']=$n; print(json.dumps(d))" | tee -a "$results"
  done
done

python3 - "$results" <<'PY'
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
by = collections.defaultdict(dict)
for r in rows:
    by[r["port"]][r["copies"]] = r
sizes = sorted({r["copies"] for r in rows})
print()
print("| port | " + " | ".join(f"{s}x ms" for s in sizes) + f" | {sizes[-1]}x/{sizes[0]}x growth | peak RSS MiB at {sizes[-1]}x |")
print("|---|" + "---|" * (len(sizes) + 2))
for port, d in by.items():
    cells = " | ".join(f"{d[s]['median_ms']}" for s in sizes)
    growth = d[sizes[-1]]["median_ms"] / d[sizes[0]]["median_ms"]
    print(f"| {port} | {cells} | {growth:.1f}x | {d[sizes[-1]]['peak_rss_mib']} |")
PY
