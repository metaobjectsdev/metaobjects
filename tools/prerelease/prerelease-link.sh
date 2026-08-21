#!/usr/bin/env bash
# Point a downstream project at the private PRE-RELEASE registry — and take it back off
# again — in one command per direction.
#
#   tools/prerelease/prerelease-link.sh link [--version 0.24.0-rc.3]
#   tools/prerelease/prerelease-link.sh unlink [--to 0.23.2]
#   tools/prerelease/prerelease-link.sh check
#
# Run it from the consumer project root, or pass --project <dir>. It detects which
# ecosystems the project uses (npm / python / nuget / maven) and configures only those.
#
# ── why the config is per-project and never machine-global ────────────────────────────
# A user-level ~/.npmrc, ~/.m2/settings.xml, ~/.config/NuGet/NuGet.Config or ~/.pypirc
# would be less typing and is the wrong answer, for three reasons:
#
#   1. It is invisible to the pin detector. The detector reads the PROJECT. A machine-wide
#      redirect leaves nothing in the repository to find, so "is this branch safe to merge?"
#      becomes unanswerable by any check — which is the whole failure this design exists to
#      make impossible.
#   2. It switches every project at once. You cannot have one consumer on a pre-release and
#      the rest on public releases, which is exactly the comparison you usually want.
#   3. A silent fall-back to user-level config is how a pre-release reached a PUBLIC registry
#      during this design's own validation: a tool ignored the config it was handed, found
#      the user-level file instead, and published for real. Machine-global config is not a
#      convenience here, it is the loaded gun.
#
# Everything this script writes is delimited by managed markers, so `unlink` removes exactly
# what `link` added and nothing else.
set -euo pipefail

BEGIN='# >>> metaobjects prerelease (managed) >>>'
END='# <<< metaobjects prerelease (managed) <<<'
XBEGIN='<!-- >>> metaobjects prerelease (managed) >>> -->'
XEND='<!-- <<< metaobjects prerelease (managed) <<< -->'

# The vendor coordinates this manages.
NPM_SCOPE='@metaobjectsdev'
PY_DIST='metaobjects'
NUGET_PREFIX='MetaObjects'
MVN_GROUP='com.metaobjects'

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$PWD"
ACTION="${1:-}"; shift || true
VERSION=""; TO=""; FRESH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project)  PROJECT="$(cd "$2" && pwd)"; shift 2 ;;
    --version)  VERSION="$2"; shift 2 ;;
    --to)       TO="$2"; shift 2 ;;
    --fresh)    FRESH=1; shift ;;
    --registry) MO_REGISTRY_BASE="$2"; shift 2 ;;
    --owner)    MO_REGISTRY_OWNER="$2"; shift 2 ;;
    -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── registry config: flags, then env, then a registry.env next to this script ─────────
# Nothing is defaulted. The TOKEN is a credential and the OWNER is an account name, which
# are the obvious two — but the registry ADDRESS is infrastructure belonging to whoever
# runs it, and this repository is public, so a committed default would publish one
# operator's hostname to every reader and every fork. Reads are anonymous, so a
# collaborator outside the project needs the address and the owner, and no token:
#
#     MO_REGISTRY_BASE=https://<registry> MO_REGISTRY_OWNER=<owner> \
#       tools/prerelease/prerelease-link.sh link --version <ver>
# shellcheck source=/dev/null
[ -f "$HERE/registry.env" ] && . "$HERE/registry.env"
BASE="${MO_REGISTRY_BASE:-}"; OWNER="${MO_REGISTRY_OWNER:-}"; TOKEN="${MO_REGISTRY_TOKEN:-}"
BASE="${BASE%/}"

need_registry() {
  [ -n "$BASE" ]  || die "set MO_REGISTRY_BASE (or pass --registry) — the pre-release registry's base URL; see tools/prerelease/registry.env.example"
  [ -n "$OWNER" ] || die "set MO_REGISTRY_OWNER (or pass --owner) — the registry account that hosts the packages"
}
HOSTPORT="${BASE#*://}"

# ── version normalization — the same table as scripts/prerelease.mjs ──────────────────
# canonical  <base>-rc.<N>  ->  npm/nuget verbatim · PEP 440 <base>rc<N> · Maven 7.<min>.<pat>-rc.<N>
py_version()    { echo "$1" | sed -E 's/-rc\.([0-9]+)$/rc\1/'; }
maven_version() { echo "$1" | sed -E 's/^[0-9]+\./7./'; }

# ── ecosystem detection ───────────────────────────────────────────────────────────────
# Detection walks the project, it does not test the root. A Maven- or pip-rooted monorepo
# with JS apps in sub-directories has no root package.json, so a root-only test skipped npm
# ENTIRELY — no .npmrc, no repin, nothing — and `link` still reported success. Every vendor
# dependency silently stayed on the previous release while the adopter believed they were
# testing the RC: a false green, which is worse than a hard failure for an evaluation.
has_npm()   { [ -n "$(project_find -name package.json | head -1)" ]; }
has_py()    { [ -n "$(project_find \( -name pyproject.toml -o -name 'requirements*.txt' \) | head -1)" ]; }
# Any .NET project/solution file at ANY depth — a single `ls a b c` would require ALL its
# arguments to exist (ls exits non-zero when ANY one is missing) and so essentially never
# fire for a real layout like MyApp.sln + src/MyApp/MyApp.csproj. obj/bin/node_modules are
# build output and vendored deps, not this project's choice of ecosystem.
has_nuget() {
  # `project_find` supplies the -print, so this takes the first line rather than -quit.
  [ -n "$(project_find \( -name '*.csproj' -o -name '*.fsproj' -o -name '*.vbproj' -o -name '*.sln' \) \
             -not -path '*/obj/*' -not -path '*/bin/*' | head -1)" ]
}
has_mvn()   { [ -f "$PROJECT/pom.xml" ]; }

detected() {
  local d=()
  has_npm   && d+=(npm)
  has_py    && d+=(python)
  has_nuget && d+=(nuget)
  has_mvn   && d+=(maven)
  [ ${#d[@]} -gt 0 ] || die "no npm / python / nuget / maven project found in $PROJECT"
  echo "${d[@]}"
}

# Remove a managed block from a file, leaving the rest byte-identical.
strip_block() {  # strip_block <file> <begin> <end>
  local f="$1" b="$2" e="$3"
  [ -f "$f" ] || return 0
  awk -v b="$b" -v e="$e" '
    index($0,b) { skip=1 } !skip { print } index($0,e) { skip=0 }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  # a file that is now empty (or only blank lines) was entirely ours
  if [ ! -s "$f" ] || ! grep -q '[^[:space:]]' "$f"; then rm -f "$f"; fi
}

# Keep an untracked managed file out of commits without touching the shared .gitignore.
local_exclude() {  # local_exclude <relative-path>
  local rel="$1" gi
  gi="$(git -C "$PROJECT" rev-parse --git-dir 2>/dev/null)" || return 0
  [ -d "$PROJECT/$gi/info" ] || mkdir -p "$PROJECT/$gi/info"
  local ex="$PROJECT/$gi/info/exclude"
  grep -qxF "$rel" "$ex" 2>/dev/null || echo "$rel" >> "$ex"
}

tracked() { git -C "$PROJECT" ls-files --error-unmatch "$1" >/dev/null 2>&1; }

# Directories under $PROJECT that are their own repository root — a linked git worktree,
# a submodule, or a vendored unrelated checkout. Everything beneath one belongs to a
# DIFFERENT working tree, on a different branch, with its own dependency pins.
#
# `-not -path '*/.git/*'` does not cover this and cannot: a linked worktree's `.git` is a
# FILE (holding `gitdir: …`), not a directory, so nothing under it was ever pruned. The
# damage is not a stray edit — `unlink` runs the same walk with `--to`, which defaults to
# the current public `latest`, so a link/unlink round-trip silently RELOCATES an unrelated
# branch's pin to a version it was never on. Matching `.git` of either kind is what makes
# the prune correct, and it picks up submodules and vendored repos for free.
foreign_roots() {
  find "$PROJECT" -mindepth 2 -name .git -not -path '*/node_modules/*' -printf '%h\n' 2>/dev/null
}

# `find` over THIS worktree only. Callers pass the match expression; pruning is ours.
project_find() {  # project_find <find-expression...>
  local prune=( -name node_modules -o -name .git ) r
  while IFS= read -r r; do prune+=( -o -path "$r" ); done < <(foreign_roots)
  find "$PROJECT" \( "${prune[@]}" \) -prune -o \( "$@" \) -print 2>/dev/null
}

# Every independent npm install root: a directory owning a lockfile, plus $PROJECT.
# npm and bun read `.npmrc` from the CURRENT directory and the user level — neither walks
# up — so a sub-project with its own lockfile needs its own registry config or it resolves
# the vendor scope against the public registry and fails `notarget` at install time.
npm_install_roots() {
  { # $PROJECT only when it is itself a JS root — a Maven- or pip-rooted repo would
    # otherwise collect a stray .npmrc it has no manifest to use.
    [ -f "$PROJECT/package.json" ] && echo "$PROJECT"
    project_find \( -name package-lock.json -o -name npm-shrinkwrap.json -o -name yarn.lock \
                 -o -name pnpm-lock.yaml -o -name bun.lock -o -name bun.lockb \) \
      | while IFS= read -r f; do dirname "$f"; done
  } | sort -u
}

# Does the registry serve reads without credentials? If it does, no project file ever has
# to hold a token — which is worth a probe.
anon_read_ok() {
  curl -fsS -o /dev/null --max-time 8 "$BASE/api/packages/$OWNER/npm/$NPM_SCOPE%2Fcli" 2>/dev/null
}

# ── version repinning, per ecosystem ──────────────────────────────────────────────────
# `unlink` must repin EVERY vendor dependency, not just the one that was installed by
# hand. The scaffolding CLI writes @metaobjectsdev/codegen-ts and @metaobjectsdev/metadata
# into a project's devDependencies at whatever version it was itself, so repinning only
# the obvious entry leaves the project resolving a pre-release it never asked for and
# failing with `notarget` on the next clean install.
repin_npm() {  # repin_npm <version|"">
  local v="$1"; [ -n "$v" ] || return 0
  # EVERY manifest, not just the root one. A workspace/monorepo keeps its vendor
  # dependencies in the member packages, so repinning only `$PROJECT/package.json`
  # leaves them resolving the OLD version — from a private registry that has only the
  # pre-release. The next clean install then fails `notarget`, which is the same failure
  # this function's other half exists to prevent, reached from a different direction.
  # (The nuget and python paths already walk/glob; npm was the odd one out.)
  local total=0 changed=0 n
  while IFS= read -r f; do
    n="$(node -e '
      const fs=require("fs"), f=process.argv[1], v=process.argv[2], scope=process.argv[3];
      let raw; try { raw = fs.readFileSync(f,"utf8"); } catch { console.log(0); process.exit(0); }
      let p; try { p = JSON.parse(raw); } catch { console.log(0); process.exit(0); }
      // PARSE to decide WHICH keys change; SUBSTITUTE textually to change them. The
      // round-trip through JSON.stringify(p,null,2) rewrote the whole file: a tab-indented
      // manifest produced 100 changed lines for one pin, and a \uXXXX escape inside a
      // description came back as a literal character. That works directly against the rule
      // this tool is trying to enforce — "never commit what link writes to a tracked file"
      // is unenforceable if a reviewer has to find one pin among fifty reformatted lines.
      // Substitution leaves the file byte-identical apart from the version literals, so
      // indentation, escapes and line endings all survive without special-casing any of them.
      const keys = new Set();
      for (const s of ["dependencies","devDependencies","peerDependencies","optionalDependencies"])
        for (const k of Object.keys(p[s]||{})) if (k.startsWith(scope+"/")) keys.add(k);
      let out = raw, n = 0;
      for (const k of keys) {
        const re = new RegExp("(\"" + k.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + "\"\\s*:\\s*\")[^\"]*(\")", "g");
        out = out.replace(re, (_m,a,b) => { n++; return a + v + b; });
      }
      if (n) fs.writeFileSync(f, out);
      console.log(n);
    ' "$f" "$v" "$NPM_SCOPE" 2>/dev/null || echo 0)"
    total=$(( total + n ))
    [ "$n" -gt 0 ] && changed=$(( changed + 1 ))
  done < <(project_find -name package.json)
  say "repinned $total $NPM_SCOPE/* dependencies to $v across $changed manifest(s)"
}

repin_py() {  # repin_py <version|"">
  local v="$1"; [ -n "$v" ] || return 0
  local pv; pv="$(py_version "$v")"
  for f in "$PROJECT/pyproject.toml" "$PROJECT"/requirements*.txt "$PROJECT"/constraints*.txt; do
    [ -f "$f" ] || continue
    sed -i -E "s/(${PY_DIST}[[:space:]]*)(==|>=|~=)[[:space:]]*[0-9][^\"',[:space:]]*/\\1==${pv}/g" "$f"
  done
  say "repinned $PY_DIST to $pv"
}

repin_nuget() {  # repin_nuget <version|"">
  local v="$1"; [ -n "$v" ] || return 0
  while IFS= read -r f; do
    sed -i -E "s|(<PackageReference[^>]*Include=\"${NUGET_PREFIX}[^\"]*\"[^>]*Version=\")[^\"]*(\")|\\1${v}\\2|g" "$f"
  done < <(project_find \( -name '*.csproj' -o -name '*.fsproj' -o -name 'Directory.Packages.props' \) \
             -not -path '*/obj/*' -not -path '*/bin/*')
  say "repinned ${NUGET_PREFIX}* package references to $v"
}

repin_mvn() {  # repin_mvn <version|"">
  local v="$1"; [ -n "$v" ] || return 0
  local mv; mv="$(maven_version "$v")"
  # A version property is the idiomatic single point of control. When the project has one,
  # rewrite ONLY that: expanding ${metaobjects.version} into a literal would silently
  # destroy the indirection the project chose, and unlink would never put it back.
  if grep -q '<metaobjects\.version>' "$PROJECT/pom.xml"; then
    sed -i -E "s|(<metaobjects\\.version>)[^<]*(</metaobjects\\.version>)|\\1${mv}\\2|g" "$PROJECT/pom.xml"
    say "repinned $MVN_GROUP dependencies to $mv (via <metaobjects.version>)"
    return 0
  fi
  # No property: rewrite the <version> inside each com.metaobjects <dependency> block.
  awk -v grp="$MVN_GROUP" -v ver="$mv" '
    /<dependency>/ { dep=1; buf=""; n=0 }
    dep { buf = buf $0 "\n"; n++
          if ($0 ~ "<groupId>[[:space:]]*" grp "[[:space:]]*</groupId>") ours=1
          if ($0 ~ /<\/dependency>/) {
            if (ours) gsub(/<version>[^<]*<\/version>/, "<version>" ver "</version>", buf)
            printf "%s", buf; dep=0; ours=0; next
          }
          next }
    { print }
  ' "$PROJECT/pom.xml" > "$PROJECT/pom.xml.tmp" && mv "$PROJECT/pom.xml.tmp" "$PROJECT/pom.xml"
  say "repinned $MVN_GROUP dependencies to $mv"
}

# Which package manager owns a root, from the lockfile it keeps. Decides the command we
# tell the adopter to run: printing `npm install` at a bun-managed repo silently migrates
# it to a different package manager and a different resolution, and the .npmrc we wrote is
# read by both tools, so the install SUCCEEDS and the swap goes unnoticed.
npm_manager_for() {  # npm_manager_for <root>
  [ -e "$1/bun.lock" ] || [ -e "$1/bun.lockb" ] && { echo "bun install"; return; }
  [ -e "$1/pnpm-lock.yaml" ] && { echo "pnpm install"; return; }
  [ -e "$1/yarn.lock" ] && { echo "yarn"; return; }
  echo "npm install"
}

# The install line for the npm ecosystem, derived from what each root actually uses.
npm_install_hint() {
  local root cmds=() c
  while IFS= read -r root; do
    c="$(npm_manager_for "$root")"
    case " ${cmds[*]-} " in *" $c "*) ;; *) cmds+=("$c") ;; esac
  done < <(npm_install_roots)
  [ ${#cmds[@]} -eq 0 ] && cmds=("npm install")
  printf '%s' "$(IFS=' / '; echo "${cmds[*]}")"
}

# Lockfiles are NOT dropped by default. Deleting one is a destructive edit to committed
# state that `unlink` cannot undo, and it turns a targeted pin into a full re-resolution of
# every unrelated transitive dependency — so a pre-release evaluation ends up testing "does
# the RC work" and "does a fresh resolve work" in the same diff, with any breakage landing
# in both. Repin-then-reconcile moves exactly the vendor packages and nothing else.
# `--fresh` opts into the old behaviour when a clean re-resolve is genuinely wanted.
drop_lockfiles() {
  [ "$FRESH" = "1" ] || return 0
  local dropped=() root
  # Every npm install root, not just $PROJECT — leaving a sub-project's lockfile behind
  # lets the two roots disagree about the resolved version, which is the same split-brain
  # the per-root .npmrc exists to prevent.
  local prefix
  while IFS= read -r root; do
    # $PROJECT itself does not match the "$PROJECT/" strip, so name its files bare.
    prefix="${root#"$PROJECT"/}"; [ "$prefix" = "$root" ] && prefix="" || prefix="$prefix/"
    for l in package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb; do
      [ -e "$root/$l" ] || continue
      tracked "${prefix}${l}" && warn "${prefix}${l} is TRACKED and is being DELETED — 'unlink' cannot restore it (git checkout -- ${prefix}${l})"
      rm -f "$root/$l"; dropped+=("${prefix}${l}")
    done
  done < <(npm_install_roots)
  for l in uv.lock poetry.lock Pipfile.lock packages.lock.json; do
    [ -e "$PROJECT/$l" ] || continue
    tracked "$l" && warn "$l is TRACKED and is being DELETED — 'unlink' cannot restore it (git checkout -- $l)"
    rm -f "$PROJECT/$l"; dropped+=("$l")
  done
  # A NuGet lock file can also sit next to each project file.
  while IFS= read -r f; do rm -f "$f"; dropped+=("$(basename "$(dirname "$f")")/packages.lock.json"); done \
    < <(project_find -name packages.lock.json -not -path '*/obj/*')
  [ ${#dropped[@]} -gt 0 ] && say "dropped lockfile(s): ${dropped[*]}" || true
}

# The newest published release, used as the default `unlink --to`.
latest_public_npm() {
  curl -fsS --max-time 10 "https://registry.npmjs.org/-/package/$NPM_SCOPE%2Fcli/dist-tags" 2>/dev/null \
    | sed -n 's/.*"latest":"\([^"]*\)".*/\1/p'
}

# ── link ──────────────────────────────────────────────────────────────────────────────
link_npm() {
  local auth=""
  if ! anon_read_ok; then
    [ -n "$TOKEN" ] || die "the registry requires authentication for reads but no MO_REGISTRY_TOKEN is set"
    auth="//$HOSTPORT/api/packages/$OWNER/npm/:_authToken=$TOKEN"
  fi
  # One .npmrc per INSTALL ROOT, not one at the project root. `repin_npm` has always
  # repinned every manifest it finds, so a sub-project with its own lockfile got the
  # pre-release pin and no registry to resolve it from — `link` reported success and the
  # breakage surfaced later as `notarget` inside that sub-project. `check` already walked
  # nested roots; that asymmetry was the bug.
  local wrote=0 root rel f
  while IFS= read -r root; do
    f="$root/.npmrc"
    strip_block "$f" "$BEGIN" "$END"
    { [ -f "$f" ] && cat "$f"; echo "$BEGIN"
      echo "$NPM_SCOPE:registry=$BASE/api/packages/$OWNER/npm/"
      [ -n "$auth" ] && echo "$auth"
      echo "$END"; } > "$f.tmp" && mv "$f.tmp" "$f"
    rel="${f#"$PROJECT"/}"; [ "$rel" = "$f" ] && rel=".npmrc"
    if tracked "$rel"; then
      warn "$rel is TRACKED in this project — the managed block is committable. Remove it with 'unlink' before pushing."
    else
      local_exclude "$rel"
    fi
    wrote=$(( wrote + 1 ))
  done < <(npm_install_roots)
  say "wrote $wrote .npmrc file(s) (scope $NPM_SCOPE only) + git local excludes"
  [ -n "$auth" ] && warn "the registry required a token, so .npmrc now holds a credential — do not commit it"
  repin_npm "$VERSION"
}

link_py() {
  local f="$PROJECT/pyproject.toml"
  [ -f "$f" ] || { warn "no pyproject.toml — configure pip manually, or add one"; return 0; }
  strip_block "$f" "$BEGIN" "$END"
  # `explicit = true` + [tool.uv.sources] is per-package index pinning: nothing resolves
  # from this index unless a source names it, so the rest of PyPI is untouched. pip's
  # --extra-index-url has no equivalent, which is why uv is the documented path.
  { cat "$f"; echo; echo "$BEGIN"
    echo '[[tool.uv.index]]'
    echo 'name = "metaobjects-prerelease"'
    echo "url = \"$BASE/api/packages/$OWNER/pypi/simple\""
    echo 'explicit = true'
    echo
    echo '[tool.uv.sources]'
    echo "$PY_DIST = { index = \"metaobjects-prerelease\" }"
    echo "$END"; } > "$f.tmp" && mv "$f.tmp" "$f"
  warn "pyproject.toml is tracked by definition — the managed block is committable; 'unlink' removes it"
  repin_py "$VERSION"
}

link_nuget() {
  local f="$PROJECT/NuGet.config" existed=0
  [ -f "$f" ] && existed=1
  if [ "$existed" -eq 0 ]; then
    cat > "$f" <<XML
<?xml version="1.0" encoding="utf-8"?>
$XBEGIN
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
    <add key="metaobjects-prerelease" value="$BASE/api/packages/$OWNER/nuget/index.json" protocolVersion="3" allowInsecureConnections="true" />
  </packageSources>
  <!-- Per-package source pinning: ${NUGET_PREFIX}* may come ONLY from the pre-release
       registry, everything else ONLY from nuget.org. -->
  <packageSourceMapping>
    <packageSource key="nuget.org"><package pattern="*" /></packageSource>
    <packageSource key="metaobjects-prerelease"><package pattern="${NUGET_PREFIX}*" /></packageSource>
  </packageSourceMapping>
</configuration>
$XEND
XML
    local_exclude "NuGet.config"
    say "wrote NuGet.config (packageSourceMapping: ${NUGET_PREFIX}* only) + git local exclude"
  else
    warn "NuGet.config already exists and is not managed by this script."
    warn "Add by hand, inside $XBEGIN / $XEND markers:"
    warn "  <add key=\"metaobjects-prerelease\" value=\"$BASE/api/packages/$OWNER/nuget/index.json\" protocolVersion=\"3\" allowInsecureConnections=\"true\" />"
    warn "  and a <packageSource key=\"metaobjects-prerelease\"><package pattern=\"${NUGET_PREFIX}*\" /></packageSource> mapping"
  fi
  repin_nuget "$VERSION"
}

link_mvn() {
  local f="$PROJECT/pom.xml"
  strip_block "$f" "$XBEGIN" "$XEND"
  awk -v b="$XBEGIN" -v e="$XEND" -v url="$BASE/api/packages/$OWNER/maven" '
    /<\/project>/ && !done {
      print "  " b
      print "  <repositories>"
      print "    <repository>"
      print "      <id>metaobjects-prerelease</id>"
      print "      <url>" url "</url>"
      print "      <releases><enabled>true</enabled><updatePolicy>always</updatePolicy></releases>"
      print "      <snapshots><enabled>true</enabled><updatePolicy>always</updatePolicy></snapshots>"
      print "    </repository>"
      print "  </repositories>"
      # Maven resolves PLUGINS exclusively from <pluginRepositories>; <repositories> does
      # not apply to them. Without this, `metaobjects-maven-plugin` is looked up in central
      # only and the build fails right after `link` reports success — and Maven-side codegen
      # is the main reason to depend on MetaObjects from Maven at all.
      print "  <pluginRepositories>"
      print "    <pluginRepository>"
      print "      <id>metaobjects-prerelease</id>"
      print "      <url>" url "</url>"
      print "      <releases><enabled>true</enabled><updatePolicy>always</updatePolicy></releases>"
      print "      <snapshots><enabled>true</enabled><updatePolicy>always</updatePolicy></snapshots>"
      print "    </pluginRepository>"
      print "  </pluginRepositories>"
      print "  " e
      done=1
    }
    { print }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  warn "pom.xml is tracked by definition — the managed block is committable; 'unlink' removes it"

  # Maven 3.8.1+ ships a built-in `maven-default-http-blocker` mirror that refuses EVERY
  # plain-http repository, so an http:// registry fails with "Blocked mirror for
  # repositories" and no hint that the block is the cause. Unblocking it belongs in
  # settings, and settings are per-user — except that `.mvn/maven.config` is read
  # automatically from the project, and `-gs` MERGES with the user's own settings instead
  # of replacing them (`-s` would replace, silently dropping the user's credentials).
  case "$BASE" in
    http://*)
      if [ -e "$PROJECT/.mvn/maven.config" ] || [ -e "$PROJECT/.mvn/settings.xml" ]; then
        warn ".mvn/ already exists — add by hand so Maven will talk to an http registry:"
        warn "  .mvn/settings.xml   a <mirror> with id maven-default-http-blocker and <blocked>false</blocked>"
        warn "  .mvn/maven.config   the two lines: -gs  and  .mvn/settings.xml"
      else
        mkdir -p "$PROJECT/.mvn"
        cat > "$PROJECT/.mvn/settings.xml" <<XML
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  $XBEGIN
  <mirrors>
    <!-- Maven 3.8.1+ blocks all plain-http repositories by default. This disables that
         blocker so the pre-release registry is reachable. Merged with (not substituted
         for) your own ~/.m2/settings.xml via -gs in .mvn/maven.config. -->
    <mirror>
      <id>maven-default-http-blocker</id>
      <mirrorOf>dummy</mirrorOf>
      <name>disabled by the metaobjects pre-release link</name>
      <url>http://0.0.0.0/</url>
      <blocked>false</blocked>
    </mirror>
  </mirrors>
  $XEND
</settings>
XML
        printf -- '-gs\n.mvn/settings.xml\n' > "$PROJECT/.mvn/maven.config"
        local_exclude ".mvn/settings.xml"; local_exclude ".mvn/maven.config"
        say "wrote .mvn/settings.xml + .mvn/maven.config (http repositories are blocked by default since Maven 3.8.1)"
      fi
      warn "the registry is plain http — serve it over https and this workaround goes away" ;;
  esac
  repin_mvn "$VERSION"
}

install_detector() {
  local dst="$PROJECT/tools/prerelease/detect-prerelease-pins.sh"
  [ "$HERE/detect-prerelease-pins.sh" -ef "$dst" ] && return 0
  mkdir -p "$(dirname "$dst")"
  cp "$HERE/detect-prerelease-pins.sh" "$dst"; chmod +x "$dst"
  say "installed tools/prerelease/detect-prerelease-pins.sh — COMMIT IT and run it in CI"
}

run_detector() {
  local detector="$PROJECT/tools/prerelease/detect-prerelease-pins.sh"
  [ -x "$detector" ] || detector="$HERE/detect-prerelease-pins.sh"
  MO_REGISTRY_BASE="$BASE" "$detector" "$PROJECT"
}

# ── unlink ────────────────────────────────────────────────────────────────────────────
unlink_all() {
  # Every root `link` could have written to, or a sub-project keeps a managed block
  # pointing at a registry that will not serve it once the pre-release is gone.
  while IFS= read -r root; do strip_block "$root/.npmrc" "$BEGIN" "$END"; done < <(npm_install_roots)
  strip_block "$PROJECT/pyproject.toml" "$BEGIN" "$END"
  strip_block "$PROJECT/NuGet.config"  "$XBEGIN" "$XEND"
  strip_block "$PROJECT/pom.xml"       "$XBEGIN" "$XEND"
  # The http-blocker workaround is a whole file we authored, not a block inside someone
  # else's — so it is removed by identity (does it carry our marker?), not by stripping.
  # Leaving it behind would keep Maven's plain-http blocker disabled for this project
  # forever, which is a security default we only ever meant to suspend.
  if [ -f "$PROJECT/.mvn/settings.xml" ] && grep -qF "$XBEGIN" "$PROJECT/.mvn/settings.xml"; then
    rm -f "$PROJECT/.mvn/settings.xml"
    if [ -f "$PROJECT/.mvn/maven.config" ] && grep -qx -- '-gs' "$PROJECT/.mvn/maven.config"; then
      rm -f "$PROJECT/.mvn/maven.config"
    fi
    rmdir "$PROJECT/.mvn" 2>/dev/null || true
    say "removed the .mvn http-blocker workaround"
  fi
  say "removed managed registry config"
}

# ── main ──────────────────────────────────────────────────────────────────────────────
case "$ACTION" in
  link)
    need_registry
    curl -fsS -o /dev/null --max-time 8 "$BASE/" || die "registry $BASE is not reachable"
    echo
    echo "── linking $PROJECT → $BASE (owner $OWNER) ──"
    [ -n "$VERSION" ] && say "pinning vendor dependencies to $VERSION"
    for eco in $(detected); do
      case "$eco" in
        npm)    link_npm ;;
        python) link_py ;;
        nuget)  link_nuget ;;
        maven)  link_mvn ;;
      esac
    done
    install_detector
    drop_lockfiles
    echo
    ok "linked. Install/restore, then iterate:"
    # Derived from each root's own lockfile — see npm_manager_for. With lockfiles now kept
    # (no --fresh), the reconcile is just an install against the edited manifest, which
    # moves the vendor packages and leaves every unrelated transitive dependency alone.
    has_npm   && say "npm    $(npm_install_hint)"
    has_py    && say "python uv lock && uv sync"
    has_nuget && say "nuget  dotnet restore --force-evaluate --no-cache   # both flags: NuGet caches the service index"
    has_mvn   && say "maven  mvn -U compile"
    echo
    warn "this project now depends on artifacts that exist ONLY on the private registry."
    warn "run 'unlink' before pushing anything from it."
    ;;

  unlink)
    if [ -z "$TO" ]; then
      TO="$(latest_public_npm || true)"
      [ -n "$TO" ] || die "could not determine the latest published version — pass --to <version>"
      say "no --to given; using the current published release $TO"
    fi
    echo
    echo "── unlinking $PROJECT → public registries @ $TO ──"
    unlink_all
    has_npm   && repin_npm   "$TO"
    has_py    && repin_py    "$TO"
    has_nuget && repin_nuget "$TO"
    has_mvn   && repin_mvn   "$TO"
    drop_lockfiles
    echo
    if run_detector; then
      ok "unlinked and verified clean — reinstall to regenerate the lockfile from public registries"
    else
      die "unlink left pre-release references behind (listed above) — fix them before pushing"
    fi
    ;;

  check)
    run_detector
    ;;

  -h|--help|help)
    sed -n '2,12p' "$0"
    exit 0 ;;

  *)
    sed -n '2,12p' "$0"
    exit 2 ;;
esac
