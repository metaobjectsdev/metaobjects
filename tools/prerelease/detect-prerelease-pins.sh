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
# 2. A private-network or loopback host DECLARED AS A PACKAGE SOURCE — RFC1918, loopback,
#    link-local, and the .local/.lan/.internal/.home suffixes. A consumer usually does
#    not have the publisher's registry.env, so pattern 1 alone would silently pass.
#    "Declared as a package source" is the whole point and was once merely "appears in a
#    manifest": a Gradle `buildConfigField("SERVER_URL", "http://10.0.0.5:8000")` is where
#    the built app looks for its OWN backend and says nothing about where Gradle resolves
#    dependencies, yet it failed the gate permanently, with no way for such a project to
#    pass. See the two-tier split below.
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

# The pre-release registry's host comes from MO_REGISTRY_BASE (env, or the registry.env
# beside this script). It is NOT defaulted: the address is infrastructure belonging to
# whoever runs the registry, and this file ships into consumer repositories, so a
# committed hostname would propagate one operator's infrastructure to every adopter.
#
# Without it, check 1 cannot run. It is announced rather than skipped in silence — a
# guard that says nothing when it does not run is indistinguishable from one that ran and
# found nothing, which is the failure mode this whole script exists to prevent. The other
# four checks are host-independent and still run; check 3 in particular catches a
# pre-release PIN regardless of where it came from.
CFG="$(cd "$(dirname "$0")" && pwd)/registry.env"
# shellcheck source=/dev/null
[ -f "$CFG" ] && . "$CFG"
REGISTRY_HOST=""
if [ -n "${MO_REGISTRY_BASE:-}" ]; then
  h="${MO_REGISTRY_BASE#*://}"; REGISTRY_HOST="${h%%/*}"
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
  --include='settings.gradle' --include='settings.gradle.kts'
  --include=gradle.properties --include=settings.xml --include=libs.versions.toml
)

# Check 2 splits those in two, because "is this file a manifest?" is the wrong question
# to ask of a host string. The right one is "is this host declared as a place packages
# come from?", and the answer depends on WHERE in the file it sits.
#
# Tier A — files that are package-resolution config end to end. Every host in one is a
# package source by construction, so the whole file is scanned, exactly as before. This is
# also where a real link leaves its fingerprints: `.npmrc` gets the registry line and the
# lockfile records the resolved URL, so narrowing tier B costs no detection on the npm
# path at all.
RESOLUTION_CONFIG=(
  --include=.npmrc --include=.yarnrc.yml
  --include=package-lock.json --include=npm-shrinkwrap.json --include=yarn.lock
  --include=pnpm-lock.yaml --include=bun.lock
  --include=pip.conf --include=.pypirc --include='requirements*.txt'
  --include='constraints*.txt' --include=uv.lock --include=poetry.lock
  --include=Pipfile --include=Pipfile.lock
  --include=NuGet.config --include=nuget.config --include=packages.lock.json
  --include=packages.config --include=paket.dependencies
  --include=settings.xml
)

# Tier B — files that carry BOTH package sources and project or application configuration.
# A host here counts only inside the region that declares a source: a Gradle
# `repositories { }` / `pluginManagement { }` block, a pom's `<repositories>`, a
# package.json dependency block or `registry` key, a pyproject index/source section. The
# rest of the file is the project's own business. This is the same principle the manifest
# list above already applies between files — a source file starting a server on 127.0.0.1
# is not a dependency on anything — carried one level down, into the files where both
# kinds of content live together.
MIXED_MANIFESTS=(
  --include=package.json --include=pyproject.toml --include=setup.cfg
  --include='*.csproj' --include='*.fsproj' --include='*.vbproj'
  --include='Directory.*.props' --include='Directory.*.targets'
  --include=pom.xml
  --include='build.gradle' --include='build.gradle.kts'
  --include='settings.gradle' --include='settings.gradle.kts'
  --include=gradle.properties --include=libs.versions.toml
)

# Arm 3b below applies ONLY to these. In a lockfile the package name and its version sit
# on different lines, so a same-line namespace match cannot see the pair and a proximity
# window is the only way to read it. Every other manifest format keeps name and version on
# ONE line, where arm 3a already reads them exactly — running the window there instead
# flags a third-party beta that merely happens to sit near a vendor entry, which is the
# cry-wolf failure this check must not have.
LOCKFILES=(
  --include=package-lock.json --include=npm-shrinkwrap.json --include=yarn.lock
  --include=pnpm-lock.yaml --include=bun.lock
  --include=uv.lock --include=poetry.lock --include=Pipfile.lock
  --include=packages.lock.json
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
  # DO NOT pipe grep into `head` here. Under `set -o pipefail` a truncated pipe makes grep
  # die of SIGPIPE (141) once its output exceeds the ~64KB pipe buffer, the pipeline reports
  # that failure, `|| return 0` fires, and the hit is NEVER recorded. The effect is inverted
  # severity: the MORE violations there are, the likelier this passes. Measured against this
  # script before the fix -- 5 violations exited 1, 400 violations exited 0.
  #
  # So: capture everything, decide on the full result, and truncate only for DISPLAY --
  # announcing what was withheld, because a guard that silently shows less than it found is
  # indistinguishable from one that found less.
  out=$(grep -rInE --binary-files=without-match "${MANIFESTS[@]}" "${EXCLUDES[@]}" "$@" "$ROOT" 2>/dev/null) || true
  [ -n "$out" ] || return 0
  hit "$label"
  local n
  n=$(printf '%s\n' "$out" | wc -l)
  # shellcheck disable=SC2001
  printf '%s\n' "$out" | head -20 | sed 's/^/      /' >&2
  [ "$n" -gt 20 ] && echo "      ... and $((n - 20)) more not shown" >&2
  return 0
}

# Print every line of a file, `grep -n` style. The tier-A extractor.
cat_all() { grep -nE '' -- "$1"; }

# Print only the lines of a file that sit inside a region declaring a PACKAGE SOURCE.
# The tier-B extractor; the caller then matches the host pattern against what comes back.
#
# The region rules are per format family, keyed off the filename:
#
#   gradle  `repositories { }`, `pluginManagement { }`, `dependencyResolutionManagement { }`
#           — brace-tracked, so a nested `maven { url = uri(...) }` is inside and a
#           `buildConfigField`, `manifestPlaceholders` or `resValue` elsewhere is not.
#   xml     `<repositories>`, `<pluginRepositories>`, `<distributionManagement>`,
#           `<mirrors>`, `<packageSources>`, `<RestoreSources>` and their singular forms.
#           Opens are counted before the line is emitted, so a single-line
#           `<RestoreSources>http://…</RestoreSources>` is caught.
#   json    a dependency-family block (brace-tracked) or an explicit `registry` /
#           `resolved` / `resolution` / `tarball` key.
#   ini     a section header naming a source (`[[tool.uv.index]]`, `[[tool.poetry.source]]`,
#           `[easy_install]`…) or an index/registry key on the line itself.
#   props   no sections at all, so the KEY must name one (repo/registry/maven/mirror/index).
#
# Braces and tags inside string literals are counted naively. A URL containing one is not
# a thing that occurs, and the alternative is a parser per format.
source_section_lines() {
  local f="$1" kind
  case "$f" in
    *build.gradle|*build.gradle.kts|*settings.gradle|*settings.gradle.kts) kind=gradle ;;
    *pom.xml|*.csproj|*.fsproj|*.vbproj|*Directory.*.props|*Directory.*.targets) kind=xml ;;
    *package.json) kind=json ;;
    *pyproject.toml|*setup.cfg|*libs.versions.toml) kind=ini ;;
    *gradle.properties) kind=props ;;
    *) kind=props ;;
  esac
  awk -v kind="$kind" '
    function count(s, c,   n, i) {
      n = 0
      for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == c) n++
      return n
    }
    # Brace-tracked block opened by a keyword line. Shared by gradle and json.
    function braces(   opened) {
      if (!sect && $0 ~ opener) { sect = 1; depth = 0; opened = 1 }
      if (!sect) return 0
      depth += count($0, "{") - count($0, "}")
      # The opening line itself counts: a one-liner closes on the same line, after
      # having been emitted.
      if (depth <= 0 && !opened) { sect = 0; return 1 }
      if (depth <= 0 && opened) { sect = 0; return 1 }
      return 1
    }
    BEGIN {
      if (kind == "gradle")
        opener = "(^|[^A-Za-z0-9_.])(repositories|pluginManagement|dependencyResolutionManagement)[[:space:]]*\\{"
      else if (kind == "json")
        opener = "\"(dependencies|devDependencies|peerDependencies|optionalDependencies|overrides|resolutions|publishConfig)\"[[:space:]]*:[[:space:]]*\\{"
      xopen  = "<(repositories|pluginRepositories|repository|pluginRepository|snapshotRepository|distributionManagement|mirrors|mirror|packageSources|RestoreSources)([[:space:]][^>]*)?>"
      xclose = "</(repositories|pluginRepositories|repository|pluginRepository|snapshotRepository|distributionManagement|mirrors|mirror|packageSources|RestoreSources)>"
      # A key that names a package source wherever it appears.
      jsonkey = "\"(registry|resolved|resolution|tarball)\"[[:space:]]*:"
      inikey  = "(^|[^A-Za-z_-])(index[-_]url|extra[-_]index[-_]url|find[-_]links|registry|repository)[[:space:]]*="
      inisect = "^[[:space:]]*\\[\\[?[^]]*(index|source|repos|repositor|registr|easy_install)[^]]*\\]\\]?"
      # Matched against a lower-cased copy of the line: property keys are camelCase by
      # convention (`prereleaseRepoUrl`), so a case-sensitive pattern misses the ones
      # that matter most.
      propkey = "^[[:space:]]*[a-z0-9_.-]*(repo|registry|maven|mirror|index)[a-z0-9_.-]*[[:space:]]*[=:]"
    }
    kind == "gradle" || kind == "json" {
      hit = braces()
      if (!hit && kind == "json" && $0 ~ jsonkey) hit = 1
      if (hit) print NR": "$0
      next
    }
    kind == "xml" {
      sect += gsub(xopen, "&")
      if (sect > 0) print NR": "$0
      sect -= gsub(xclose, "&")
      if (sect < 0) sect = 0
      next
    }
    kind == "ini" {
      if ($0 ~ /^[[:space:]]*\[/) sect = ($0 ~ inisect) ? 1 : 0
      if (sect || $0 ~ inikey) print NR": "$0
      next
    }
    { if (tolower($0) ~ propkey) print NR": "$0 }
  ' "$f"
}

# scan_files <label> <newline-separated file list> <extractor>
#
# Runs `extractor <file>` and reports whichever of its lines carry a private host. Split
# from `scan` because the tier-B answer is not a property of the file — it is a property
# of the region, so the candidate lines have to be produced before the match runs.
scan_files() {
  local label="$1" files="$2" extractor="$3" f out
  [ -n "$files" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # Unlike scan() this pipeline is SAFE to truncate for the verdict -- it is guarded on
    # $out's CONTENT, not on the pipeline's exit status, so a SIGPIPE'd grep still leaves the
    # lines head printed and hit() still fires. Only the DISPLAY is capped, and the withheld
    # count is announced for the same reason it is there.
    out=$("$extractor" "$f" | grep -E -- "$PRIVATE_HOST_RE") || true
    [ -n "$out" ] || continue
    hit "$label"
    local n
    n=$(printf '%s\n' "$out" | wc -l)
    # shellcheck disable=SC2001
    printf '%s\n' "$out" | head -20 | sed "s|^|      $f:|" >&2
    [ "$n" -gt 20 ] && echo "      ... and $((n - 20)) more not shown in $f" >&2
  done <<< "$files"
}

# 1 + 2 — registry addresses.
if [ -n "$REGISTRY_HOST" ]; then
  scan "project points at the pre-release registry ($REGISTRY_HOST)" -- "$REGISTRY_HOST"
else
  echo "  · check 1 NOT RUN: set MO_REGISTRY_BASE to scan for the pre-release registry's address" >&2
fi

# Tier A: whole file — every host in a resolution-config file is a package source.
scan_files "project points at a private-network or loopback package registry" \
  "$(grep -rIlE --binary-files=without-match "${RESOLUTION_CONFIG[@]}" "${EXCLUDES[@]}" \
       -- "$PRIVATE_HOST_RE" "$ROOT" 2>/dev/null)" cat_all
# Tier B: only the regions that declare a package source.
scan_files "project points at a private-network or loopback package registry" \
  "$(grep -rIlE --binary-files=without-match "${MIXED_MANIFESTS[@]}" "${EXCLUDES[@]}" \
       -- "$PRIVATE_HOST_RE" "$ROOT" 2>/dev/null)" source_section_lines

# 3 — a vendor dependency pinned to a pre-release version.
scan "vendor dependency pinned to a pre-release version" -- "($NS_RE).*$PRERELEASE_RE"
# XML is deliberately excluded here and handled by check 5 instead: a pom's own
# <version>1.0.0-SNAPSHOT</version> is normal and must not be flagged.
#
# 3b — LOCKFILES only. There the package name and its version are on different lines, so
# the same-line arm above cannot see the pair; a vendor namespace token within a few lines
# of the version is the best available signal. Deliberately NOT run over other manifests:
# there name and version share a line, arm 3a reads them exactly, and the window would
# instead flag a third-party rc/beta that merely sits near a vendor entry — a check that
# cries wolf is a check people learn to ignore.
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
    # shellcheck disable=SC2001
    echo "$bad" | sed "s|^|      $f:|" >&2
  fi
done < <(grep -rIlE --binary-files=without-match "${LOCKFILES[@]}" "${EXCLUDES[@]}" \
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
    # shellcheck disable=SC2001
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

That removes the registry config, repins every vendor dependency, and re-runs this check.

It does NOT delete or rewrite your lockfile — a lockfile is committed state `unlink` could
not restore. So if the references above are in one (`package-lock.json`, `uv.lock`, …),
repinning cannot clear them: reconcile with your project's own install command
(`npm install` / `uv sync` / `dotnet restore --force-evaluate`) and run `check` again.
`unlink` names the offending lockfiles and the exact command for them.
MSG
  exit 1
fi
echo "detect-prerelease-pins: ✓ no private-registry config and no pre-release pin"
