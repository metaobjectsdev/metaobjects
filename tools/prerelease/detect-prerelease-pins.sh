#!/usr/bin/env bash
# Fail if a project is wired to a PRIVATE package registry, or depends on a pre-release
# version that only exists there.
#
#   tools/prerelease/detect-prerelease-pins.sh [project-dir]      # default: .
#   MO_REGISTRY_BASE=http://host:port  …/detect-prerelease-pins.sh
#
# Copy this into every downstream consumer that participates in pre-release testing and
# run it in CI and from a pre-commit hook.
#
# ── why this is load-bearing, not belt-and-braces ─────────────────────────────────────
# A pre-release registry on a private network is reachable from every machine on that
# network, so "it only works on my laptop" is NOT a containment guarantee. This scan is
# what actually stops a private-registry dependency reaching a shared branch. Treat a
# failure here as a build break, never as advice.
#
# ── what it looks for ─────────────────────────────────────────────────────────────────
# 1. The pre-release registry's host. Defaulted, so a consumer repo that has never seen
#    the publisher's config still catches it; MO_REGISTRY_BASE adds another.
# 2. ANY private-network or loopback host in a manifest/lockfile — RFC1918, loopback,
#    link-local, and the .local/.lan/.internal/.home suffixes. A consumer usually does
#    not have the publisher's registry.env, so pattern 1 alone would silently pass.
# 3. A vendor dependency pinned to a pre-release version. This is the only signal that
#    survives `pip freeze`, which records no index provenance whatsoever.
# 4. An npm dependency declared as a bare dist-tag — it floats, so it resolves to
#    whatever the registry currently calls that tag.
# 5. A Maven pom pinning a pre-release in a <dependency> or <properties> block. The
#    groupId and the version live on different lines (or behind a property), so a
#    same-line match cannot see it. The project's OWN 1.0.0-SNAPSHOT version is normal
#    and is deliberately not flagged.
#
# Pure text scan: no network, no package manager, no toolchain.
set -uo pipefail

ROOT="${1:-.}"

# The vendor namespaces whose pre-release pins matter. Edit for your own scopes.
NS_RE='@metaobjectsdev/|com\.metaobjects|(^|[^A-Za-z])MetaObjects(\.|"|<|$)|(^|[^A-Za-z-])metaobjects([^A-Za-z-]|$)'

# The pre-release registry's host, known by default so this check needs no configuration
# in a consumer repo — which matters, because the consumer is exactly where nobody has the
# publisher's config. MO_REGISTRY_BASE overrides it for a different registry.
DEFAULT_REGISTRY_HOST='gitea.mealing.com'
CFG="$(cd "$(dirname "$0")" && pwd)/registry.env"
[ -f "$CFG" ] && . "$CFG"
REGISTRY_HOST="$DEFAULT_REGISTRY_HOST"
if [ -n "${MO_REGISTRY_BASE:-}" ]; then
  h="${MO_REGISTRY_BASE#*://}"; h="${h%%/*}"
  [ "$h" = "$DEFAULT_REGISTRY_HOST" ] || REGISTRY_HOST="$DEFAULT_REGISTRY_HOST|$h"
fi

# Private/loopback/link-local hosts, and the suffixes used for LAN-only names.
PRIVATE_HOST_RE='https?://(localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|0\.0\.0\.0|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|169\.254\.[0-9]+\.[0-9]+|\[::1\]|[A-Za-z0-9._-]+\.(local|lan|internal|home|localdomain))(:[0-9]+)?'

# A pre-release version in any of the four spellings we emit.
#   npm / NuGet / Maven   0.24.0-rc.3 · 7.24.0-rc.3 · x-SNAPSHOT · -alpha/-beta
#   PEP 440               0.24.0rc3 · 0.24.0.dev1
PRERELEASE_RE='[0-9]+\.[0-9]+\.[0-9]+(-(rc|alpha|beta|SNAPSHOT)[.0-9]*|rc[0-9]+|\.dev[0-9]+)'
# awk builds its regex from a string, so every backslash has to survive one more round.
PRERELEASE_RE_AWK='[0-9]+\\.[0-9]+\\.[0-9]+(-(rc|alpha|beta|SNAPSHOT)[.0-9]*|rc[0-9]+|\\.dev[0-9]+)'
# NS_RE with every backslash doubled for the same reason (see the proximity check below).
NS_RE_AWK='@metaobjectsdev/|com\\.metaobjects|(^|[^A-Za-z])MetaObjects(\\.|\"|<|$)|(^|[^A-Za-z-])metaobjects([^A-Za-z-]|$)'

# Only DEPENDENCY DECLARATIONS are scanned. A source file that starts an HTTP server on
# 127.0.0.1, or a design doc quoting an old -SNAPSHOT version, is not a dependency on
# anything — scanning those produced nothing but noise, and a check that cries wolf is a
# check people learn to ignore.
MANIFESTS=(
  # npm
  --include=package.json --include=package-lock.json --include=npm-shrinkwrap.json
  --include=yarn.lock --include=pnpm-lock.yaml --include=bun.lock --include=.npmrc
  --include=.yarnrc.yml
  # python
  --include=pyproject.toml --include='requirements*.txt' --include='constraints*.txt'
  --include=uv.lock --include=poetry.lock --include=Pipfile --include=Pipfile.lock
  --include=setup.cfg --include=pip.conf --include=.pypirc
  # nuget
  --include='*.csproj' --include='*.fsproj' --include='*.vbproj'
  --include='Directory.*.props' --include='Directory.*.targets'
  --include=NuGet.config --include=nuget.config --include=packages.lock.json
  --include=packages.config --include=paket.dependencies
  # maven / gradle
  --include=pom.xml --include='build.gradle' --include='build.gradle.kts'
  --include=gradle.properties --include=settings.xml --include=libs.versions.toml
)

EXCLUDES=(
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=vendor
  --exclude-dir=".venv*" --exclude-dir=venv --exclude-dir=site-packages
  --exclude-dir=.tox --exclude-dir=.mypy_cache --exclude-dir=__pycache__
  --exclude-dir=target --exclude-dir=bin --exclude-dir=obj --exclude-dir=dist
  --exclude-dir=build --exclude-dir=.gradle --exclude-dir=.next --exclude-dir=.nuxt
)

fail=0
hit() { echo "  ✖ $1" >&2; fail=1; }

scan() {  # scan <label> <grep-args...>
  local label="$1"; shift
  local out
  out=$(grep -rInE --binary-files=without-match "${MANIFESTS[@]}" "${EXCLUDES[@]}" "$@" "$ROOT" 2>/dev/null | head -20) || return 0
  [ -n "$out" ] || return 0
  hit "$label"
  echo "$out" | sed 's/^/      /' >&2
}

# 1 + 2 — registry addresses.
scan "project points at the pre-release registry ($REGISTRY_HOST)" -- "$REGISTRY_HOST"
scan "project points at a private-network or loopback package registry" -- "$PRIVATE_HOST_RE"

# 3 — a vendor dependency pinned to a pre-release version.
scan "vendor dependency pinned to a pre-release version" -- "($NS_RE).*$PRERELEASE_RE"
# XML is deliberately excluded here and handled by check 5 instead: a pom's own
# <version>1.0.0-SNAPSHOT</version> is normal and must not be flagged.
#
# 3b — a bare quoted pre-release version, which is how it appears in LOCKFILES (name and
# version on different lines, so the same-line arm above cannot see them). Flagged only
# when a vendor namespace token appears within a few lines of the version: a naked
# version-anywhere match would also flag every third-party rc/beta a project legitimately
# depends on, and a check that cries wolf is a check people learn to ignore.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  bad=$(awk -v ns="$NS_RE_AWK" -v re="$PRERELEASE_RE_AWK" '
    { lines[NR] = $0 }
    END {
      pat = "\"" re "\"" "|==" re "|Version=\"" re
      for (i = 1; i <= NR; i++) {
        if (lines[i] !~ pat) continue
        for (j = i - 4; j <= i + 4; j++)
          if (j >= 1 && j <= NR && lines[j] ~ ns) { print i": "lines[i]; break }
      }
    }
  ' "$f")
  if [ -n "$bad" ]; then
    hit "vendor dependency pinned to a pre-release version"
    echo "$bad" | sed "s|^|      $f:|" >&2
  fi
done < <(grep -rIlE --binary-files=without-match "${MANIFESTS[@]}" "${EXCLUDES[@]}" \
           -- "\"$PRERELEASE_RE\"|==$PRERELEASE_RE|Version=\"$PRERELEASE_RE" "$ROOT" 2>/dev/null)

# 4 — a bare npm dist-tag specifier: floats, and does not exist on the public registry.
scan "npm dependency declared as a bare dist-tag" \
  --include=package.json -- '"@metaobjectsdev/[^"]+"[[:space:]]*:[[:space:]]*"(prerelease|local|next|dev)"'

# 5 — Maven: only <dependency> and <properties>, so the project's own -SNAPSHOT is safe.
while IFS= read -r pom; do
  [ -n "$pom" ] || continue
  bad=$(awk -v re="$PRERELEASE_RE_AWK" '
    /<dependency>/ { dep=1 }
    /<properties>/ { prop=1 }
    (dep || prop) && $0 ~ ("<[^>]*>" re "<") { print NR": "$0 }
    /<\/dependency>/ { dep=0 }
    /<\/properties>/ { prop=0 }
  ' "$pom")
  if [ -n "$bad" ]; then
    hit "pom pins a pre-release version (dependency or version property)"
    echo "$bad" | sed "s|^|      $pom:|" >&2
  fi
done < <(grep -rIl --exclude-dir=.git --include=pom.xml 'com\.metaobjects' "$ROOT" 2>/dev/null)

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

This project depends on artifacts from a private pre-release registry.
Those artifacts do not exist publicly: anyone else's build will fail, and there is no
version of this that is safe to merge.

Fix — from the project directory:

    tools/prerelease/prerelease-link.sh unlink --to <released-version>

That removes the registry config, repins every vendor dependency, drops the lockfile,
and re-runs this check.
MSG
  exit 1
fi
echo "detect-prerelease-pins: ✓ no private-registry config and no pre-release pin"
