#!/usr/bin/env bash
# Tests for tools/prerelease/prerelease-link.sh — the two defects an adopter hit linking a project
# to a pre-release candidate.
#
#   tools/prerelease/test-prerelease-link.sh
#
# D9  the Maven pin is npm major + 7 (1.1.0-rc.N is 8.1.0-rc.N), not a hardcoded 7.
# D11 in a linked git worktree the exclude file is the shared one in the common dir, nothing
#     stray is written into the work tree, and `link` refuses to report success while a written
#     .npmrc (which can hold a registry credential) is not ignored. The exclude entries `link`
#     adds live in one managed block, so `unlink` removes exactly that block (and nothing a
#     user put in the file by hand), and a repeated `link` does not duplicate it. Unlinking one
#     worktree keeps an entry another linked worktree of the same clone still needs.
# R3  a link/unlink round trip leaves a pom.xml that lacked a trailing newline byte-identical
#     (the previous awk-based rewrites unconditionally added one), and `link`/`unlink` report
#     "repinned ... in <file>" only for a pom whose own text actually changed — not a module
#     pom that is pinned entirely through its parent's ${metaobjects.version} property, nor for a
#     literal-pinned pom that a second `link` at the same version leaves unchanged.
# P4  a polyglot repository with one project per port and no root project files: every Maven
#     and Python project is linked and repinned, and the .NET local tool manifest too.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
# The script under test runs from a copy. It sources a `registry.env` beside itself, and a
# maintainer's checkout has one holding the real registry address and token, which would send
# these runs to that registry instead of the local one below.
mkdir -p "$WORK/tool"
cp "$HERE/prerelease-link.sh" "$HERE/detect-prerelease-pins.sh" "$WORK/tool/"
LINK="$WORK/tool/prerelease-link.sh"
SERVER_PID=""
cleanup() { [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

fails=0
pass() { printf 'ok:   %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; fails=$((fails + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

# ── D9: the Maven version, through the function itself ────────────────────────────────
maven_version_fn="$(awk '/^maven_version\(\) \{/,/^\}/' "$LINK")"
eval "$maven_version_fn"
# The shell function carries its own copy of the rule so the script works without Node or a
# checkout; scripts/maven-coordinate.mjs is where the rule is defined, so each input is also
# compared against mavenVersion() there.
reference_maven_version() {
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { mavenVersion } = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(mavenVersion(process.argv[2]));
  ' "$HERE/../../scripts/maven-coordinate.mjs" "$1"
}
for pair in "0.25.0:7.25.0" "0.24.0-rc.3:7.24.0-rc.3" "1.0.0:8.0.0" "1.1.0-rc.2:8.1.0-rc.2" "2.0.0:9.0.0" "10.4.12-rc.11:17.4.12-rc.11"; do
  in="${pair%%:*}"; want="${pair##*:}"; got="$(maven_version "$in")"
  [ "$got" = "$want" ] && pass "maven_version $in -> $want" || fail "maven_version $in -> $got, want $want"
  ref="$(reference_maven_version "$in")"
  [ "$got" = "$ref" ] && pass "maven_version $in agrees with maven-coordinate.mjs" \
    || fail "maven_version $in -> $got, maven-coordinate.mjs says $ref"
done
if maven_version "1.1" >/dev/null 2>&1; then fail "maven_version accepted a two-part version"; else pass "maven_version refuses a two-part version"; fi
# The function runs with no Node on PATH: a collaborator's JVM-only machine.
got="$(PATH=/nonexistent maven_version "1.1.0-rc.2")"
[ "$got" = "8.1.0-rc.2" ] && pass "maven_version needs nothing on PATH" || fail "maven_version without PATH -> $got"

# ── D11: link inside a linked worktree ────────────────────────────────────────────────
# A registry that answers GET / is all `link` needs from the network.
# It also answers the anonymous-read probe (`/api/packages/<owner>/npm/@metaobjectsdev%2Fcli`), so
# no token is needed.
mkdir -p "$WORK/registry/api/packages/owner/npm/@metaobjectsdev"
echo '{}' > "$WORK/registry/api/packages/owner/npm/@metaobjectsdev/cli"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
(cd "$WORK/registry" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break; sleep 0.1; done

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q "$WORK/main"
cat > "$WORK/main/package.json" <<'JSON'
{ "name": "consumer", "version": "1.0.0", "dependencies": { "@metaobjectsdev/metadata": "^1.0.0" } }
JSON
git -C "$WORK/main" add -A && git -C "$WORK/main" commit -q -m init
git -C "$WORK/main" worktree add -q "$WORK/wt" -b linked

link() {  # link <project> -> runs link, output in $WORK/out
  MO_REGISTRY_BASE="http://127.0.0.1:$PORT" MO_REGISTRY_OWNER=owner MO_REGISTRY_TOKEN="" \
    bash "$LINK" link --project "$1" --version 1.1.0-rc.9 >"$WORK/out" 2>&1
}

if link "$WORK/wt"; then pass "link succeeds in a linked worktree"; else fail "link failed: $(tail -5 "$WORK/out")"; fi
check "the .npmrc is written" '[ -f "$WORK/wt/.npmrc" ]'
check "the .npmrc is ignored by git" 'git -C "$WORK/wt" check-ignore -q -- .npmrc'
check "git status shows no .npmrc" '! git -C "$WORK/wt" status --porcelain | grep -q "\.npmrc"'
# The shared exclude file is the one git reads; no path component of the absolute git dir may
# appear inside the work tree.
common="$(git -C "$WORK/wt" rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$WORK/wt/$common" ;; esac
check "the exclude entry is in the shared exclude file" 'grep -qxF .npmrc "$common/info/exclude"'
leading="$(printf '%s' "$WORK" | cut -d/ -f2)"
check "no stray exclude tree in the work tree" '[ ! -e "$WORK/wt/$leading" ]'
check "the dependency is pinned to the candidate" 'grep -q "1.1.0-rc.9" "$WORK/wt/package.json"'
check "the exclude entry is inside a managed block" 'grep -q "metaobjects prerelease (managed)" "$common/info/exclude"'

# D11: a second `link` in the same worktree must not duplicate the entry or the block.
if link "$WORK/wt"; then pass "a second link in the same worktree succeeds"; else fail "second link failed: $(tail -5 "$WORK/out")"; fi
check "the exclude entry still appears exactly once" '[ "$(grep -cxF .npmrc "$common/info/exclude")" = 1 ]'
check "the managed block still appears exactly once (one BEGIN line, one END line)" \
  '[ "$(grep -c "metaobjects prerelease (managed)" "$common/info/exclude")" = 2 ]'

unlink_project() {  # unlink_project <project> -> runs unlink, output in $WORK/out
  MO_REGISTRY_BASE="http://127.0.0.1:$PORT" MO_REGISTRY_OWNER=owner MO_REGISTRY_TOKEN="" \
    bash "$LINK" unlink --project "$1" --to 1.0.13 >"$WORK/out" 2>&1 || true
}

# D11: the exclude file is shared by every work tree of the clone. Unlinking one work tree
# while another is still linked must keep the entry the other one's .npmrc (which can hold a
# registry credential) relies on.
git -C "$WORK/main" worktree add -q "$WORK/wt3" -b linked3
if link "$WORK/wt3"; then pass "link succeeds in a second linked worktree"; else fail "link in wt3 failed: $(tail -5 "$WORK/out")"; fi
unlink_project "$WORK/wt"
check "unlinking one worktree removes its own .npmrc" '[ ! -f "$WORK/wt/.npmrc" ]'
check "the other worktree's .npmrc is still written" '[ -f "$WORK/wt3/.npmrc" ]'
check "the other worktree's .npmrc is still ignored by git" 'git -C "$WORK/wt3" check-ignore -q -- .npmrc'
check "git status in the other worktree shows no .npmrc" '! git -C "$WORK/wt3" status --porcelain | grep -q "\.npmrc"'
check "the entry stays once, inside the managed block" \
  '[ "$(grep -cxF .npmrc "$common/info/exclude")" = 1 ] && [ "$(grep -c "metaobjects prerelease (managed)" "$common/info/exclude")" = 2 ]'

# D11: `unlink` of the last linked work tree must remove exactly the block `link` added, and
# nothing a user put in the shared exclude file by hand.
printf 'a-users-own-rule\n' >> "$common/info/exclude"
unlink_project "$WORK/wt3"
check "unlink removes the managed block from the shared exclude file" '! grep -q "metaobjects prerelease (managed)" "$common/info/exclude"'
check "unlink removes the .npmrc entry it added" '! grep -qxF .npmrc "$common/info/exclude"'
check "unlink leaves a user's own exclude rule alone" 'grep -qxF a-users-own-rule "$common/info/exclude"'

# The assertion: an .npmrc git does not ignore makes link fail.
git -C "$WORK/main" worktree add -q "$WORK/wt2" -b linked2
# A global excludes file is not what we control, so defeat the ignore by negating it in .gitignore.
printf '!.npmrc\n' > "$WORK/wt2/.gitignore"
git -C "$WORK/wt2" add .gitignore && git -C "$WORK/wt2" commit -q -m "track a rule that un-ignores .npmrc"
# local_exclude appends to the exclude file, but .gitignore (higher precedence) re-includes it.
if link "$WORK/wt2"; then fail "link reported success with a non-ignored .npmrc"; else
  grep -q "git does not ignore: .npmrc" "$WORK/out" && pass "link refuses when .npmrc is not ignored" \
    || fail "link failed, but not with the ignore message: $(tail -3 "$WORK/out")"
fi

# ── P4: a polyglot repository with one project per port and no root project files ────────
# Each port keeps its own build under ports/<port>/. `link` used to detect Maven and configure
# Python at the root only, so these needed a `link --project` run each, and it never repinned
# the .NET local tool manifest, which left `dotnet meta` on the previous release.
poly="$WORK/poly app"  # a space in the path: every root walker must keep it whole
git init -q "$poly"
mkdir -p "$poly/ports/python" "$poly/ports/java" "$poly/ports/kotlin" "$poly/ports/csharp" "$poly/.config"
cat > "$poly/ports/python/pyproject.toml" <<'TOML'
[project]
name = "consumer"
version = "0.1.0"
dependencies = ["metaobjects==1.0.9"]
TOML
cat > "$poly/ports/java/pom.xml" <<'XML'
<project>
  <properties><metaobjects.version>8.0.9</metaobjects.version></properties>
</project>
XML
mkdir -p "$poly/ports/java/module" "$poly/ports/java/inherits"
cat > "$poly/ports/java/inherits/pom.xml" <<'XML'
<project>
  <dependencies>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-om</artifactId>
      <version>${metaobjects.version}</version>
    </dependency>
  </dependencies>
</project>
XML
cat > "$poly/ports/java/module/pom.xml" <<'XML'
<project>
  <dependencies>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-om</artifactId>
      <version>8.0.9</version>
    </dependency>
  </dependencies>
</project>
XML
cat > "$poly/ports/kotlin/pom.xml" <<'XML'
<project>
  <dependencies>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-metadata-ktx</artifactId>
      <version>8.0.9</version>
    </dependency>
    <dependency>
      <groupId>org.jetbrains.exposed</groupId>
      <artifactId>exposed-core</artifactId>
      <version>0.61.0</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>com.metaobjects</groupId>
        <artifactId>metaobjects-maven-plugin</artifactId>
        <configuration>
          <generators>
            <generator><classname>x</classname></generator>
          </generators>
        </configuration>
        <dependencies>
          <dependency>
            <groupId>com.metaobjects</groupId>
            <artifactId>metaobjects-codegen-kotlin</artifactId>
            <version>8.0.9</version>
          </dependency>
          <dependency>
            <groupId>org.jetbrains.kotlin</groupId>
            <artifactId>kotlin-stdlib</artifactId>
            <version>2.0.21</version>
          </dependency>
        </dependencies>
        <version>8.0.9</version>
      </plugin>
    </plugins>
  </build>
</project>
XML
cat > "$poly/ports/csharp/App.csproj" <<'XML'
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup><PackageReference Include="MetaObjects.Codegen" Version="1.0.9" /></ItemGroup>
</Project>
XML
cat > "$poly/.config/dotnet-tools.json" <<'JSON'
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": { "version": "8.0.0", "commands": ["dotnet-ef"] },
    "metaobjects.cli": { "version": "1.0.9", "commands": ["dotnet-meta"] }
  }
}
JSON
mkdir -p "$poly/ports/csharp/.config"
cat > "$poly/ports/csharp/.config/dotnet-tools.json" <<'JSON'
{ "version": 1, "isRoot": true, "tools": { "metaobjects.cli": { "commands": ["dotnet-meta"] } } }
JSON
git -C "$poly" add -A && git -C "$poly" commit -q -m init
if link "$poly"; then pass "link succeeds in a polyglot repository"; else fail "polyglot link failed: $(tail -5 "$WORK/out")"; fi
check "a manifest with no tool version reports that nothing was pinned" 'grep -q "ports/csharp/.config/dotnet-tools.json names MetaObjects.Cli but no version for it was found: nothing pinned" "$WORK/out" && ! grep -q "repinned MetaObjects.Cli to 1.1.0-rc.9 in ports/csharp/" "$WORK/out"'
check "a repinned manifest is reported as repinned" 'grep -q "repinned MetaObjects.Cli to 1.1.0-rc.9 in .config/dotnet-tools.json" "$WORK/out"'
check "the nested python project is linked" 'grep -q "metaobjects-prerelease" "$poly/ports/python/pyproject.toml"'
check "the nested python project is repinned" 'grep -q "metaobjects==1.1.0rc9" "$poly/ports/python/pyproject.toml"'
check "each independent pom gets the repositories" 'grep -q "<pluginRepositories>" "$poly/ports/java/pom.xml" && grep -q "<pluginRepositories>" "$poly/ports/kotlin/pom.xml"'
check "a module pom inherits rather than gets a block" '! grep -q "<pluginRepositories>" "$poly/ports/java/module/pom.xml"'
check "the version property is repinned" 'grep -q "<metaobjects.version>8.1.0-rc.9</metaobjects.version>" "$poly/ports/java/pom.xml"'
check "an inherited version property is not made literal" 'grep -q "<version>\${metaobjects.version}</version>" "$poly/ports/java/inherits/pom.xml"'
check "a module dependency is repinned" 'grep -q "<version>8.1.0-rc.9</version>" "$poly/ports/java/module/pom.xml"'
check "a literal dependency version is repinned" 'grep -q "<version>8.1.0-rc.9</version>" "$poly/ports/kotlin/pom.xml"'
check "another group's version is left alone" 'grep -q "<version>0.61.0</version>" "$poly/ports/kotlin/pom.xml" && grep -q "<version>2.0.21</version>" "$poly/ports/kotlin/pom.xml"'
check "every metaobjects version in the pom is repinned, a plugin's after its configuration included" '[ "$(grep -c "<version>8.1.0-rc.9</version>" "$poly/ports/kotlin/pom.xml")" = 3 ] && ! grep -q "8.0.9" "$poly/ports/kotlin/pom.xml"'
check "the package reference is repinned" 'grep -q "Version=\"1.1.0-rc.9\"" "$poly/ports/csharp/App.csproj"'
check "the local tool manifest is repinned" 'grep -q "\"metaobjects.cli\": { \"version\": \"1.1.0-rc.9\"" "$poly/.config/dotnet-tools.json"'
check "another tool in the manifest is left alone" 'grep -q "\"dotnet-ef\": { \"version\": \"8.0.0\"" "$poly/.config/dotnet-tools.json"'
# R3: a second `link` at the same version changes no pom, so it reports no repin, a pom pinned
# by a literal <version> included.
if link "$poly"; then pass "a second polyglot link at the same version succeeds"; else fail "second polyglot link failed: $(tail -5 "$WORK/out")"; fi
check "a second link at the same version reports no literal pom as repinned" \
  '! grep -q "in ports/java/module/pom.xml" "$WORK/out" && ! grep -q "in ports/kotlin/pom.xml" "$WORK/out"'

MO_REGISTRY_BASE="http://127.0.0.1:$PORT" MO_REGISTRY_OWNER=owner MO_REGISTRY_TOKEN="" \
  bash "$LINK" unlink --project "$poly" --to 1.0.13 >"$WORK/out" 2>&1 || true
check "an inherited version property survives link and unlink" 'grep -q "<version>\${metaobjects.version}</version>" "$poly/ports/java/inherits/pom.xml" && ! grep -q "<version>8" "$poly/ports/java/inherits/pom.xml"'
check "unlink removes every managed block" '! grep -rq "metaobjects prerelease (managed)" "$poly/ports"'
check "unlink repins the nested python project" 'grep -q "metaobjects==1.0.13" "$poly/ports/python/pyproject.toml"'
check "unlink repins every pom" 'grep -q "8.0.13" "$poly/ports/java/pom.xml" && grep -q "8.0.13" "$poly/ports/java/module/pom.xml" && [ "$(grep -c "<version>8.0.13</version>" "$poly/ports/kotlin/pom.xml")" = 3 ]'
check "unlink repins the local tool" 'grep -q "\"metaobjects.cli\": { \"version\": \"1.0.13\"" "$poly/.config/dotnet-tools.json"'
check "unlink removes every .mvn workaround" '[ ! -e "$poly/ports/java/.mvn" ] && [ ! -e "$poly/ports/kotlin/.mvn" ]'

# ── R3: a pom.xml round trip is byte-identical when the pom lacked a trailing newline, and
# `link`/`unlink` only report "repinned" for a pom whose own text actually changed ─────────
# The parent declares the <metaobjects.version> property; the module only ever REFERENCES it
# via ${metaobjects.version} — nothing in the module's own text should ever be rewritten, and
# neither file ends in a newline (the shape an adopter's six real poms were in).
mvnproj="$WORK/mvnproj"
mkdir -p "$mvnproj/app"
printf '%s' '<project>
  <packaging>pom</packaging>
  <modules><module>app</module></modules>
  <properties><metaobjects.version>8.0.10</metaobjects.version></properties>
</project>' > "$mvnproj/pom.xml"
printf '%s' '<project>
  <dependencies>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-om</artifactId>
      <version>${metaobjects.version}</version>
    </dependency>
  </dependencies>
</project>' > "$mvnproj/app/pom.xml"
check "the fixture poms have no trailing newline" \
  '[ "$(tail -c1 "$mvnproj/pom.xml" | wc -l)" = 0 ] && [ "$(tail -c1 "$mvnproj/app/pom.xml" | wc -l)" = 0 ]'
git init -q "$mvnproj"
git -C "$mvnproj" add -A && git -C "$mvnproj" commit -q -m init
cp "$mvnproj/pom.xml" "$WORK/pom.xml.orig"
cp "$mvnproj/app/pom.xml" "$WORK/app-pom.xml.orig"

if MO_REGISTRY_BASE="http://127.0.0.1:$PORT" MO_REGISTRY_OWNER=owner MO_REGISTRY_TOKEN="" \
     bash "$LINK" link --project "$mvnproj" --version 1.1.0-rc.4 >"$WORK/out" 2>&1
then pass "link succeeds on the no-trailing-newline pom fixture"
else fail "link failed: $(tail -5 "$WORK/out")"
fi
check "link reports the root pom (its property changed) as repinned" \
  'grep -q "repinned com.metaobjects dependencies to 8.1.0-rc.4 in pom.xml (via <metaobjects.version>)" "$WORK/out"'
check "link does NOT report the module pom as repinned (only its parent's property changed)" \
  '! grep -q "in app/pom.xml" "$WORK/out"'

MO_REGISTRY_BASE="http://127.0.0.1:$PORT" MO_REGISTRY_OWNER=owner MO_REGISTRY_TOKEN="" \
  bash "$LINK" unlink --project "$mvnproj" --to 1.0.10 >"$WORK/out" 2>&1 || true
check "unlink does NOT report the module pom as repinned either" '! grep -q "in app/pom.xml" "$WORK/out"'
check "the round trip leaves the root pom byte-identical" 'cmp -s "$WORK/pom.xml.orig" "$mvnproj/pom.xml"'
check "the round trip leaves the module pom byte-identical" 'cmp -s "$WORK/app-pom.xml.orig" "$mvnproj/app/pom.xml"'
check "git status on the poms is clean after the round trip" \
  '[ -z "$(git -C "$mvnproj" status --porcelain -- pom.xml app/pom.xml)" ]'

# ── R4: detect-prerelease-pins.sh flags a stale pre-release agent context ──────────────
# `meta init --refresh-docs` (and `meta init` generally) stamp the running CLI's own
# version into "generatedBy" in .metaobjects/.agent-context.json, a file meant to be
# committed and tracked. Run with a pre-release CLI, that stamp is a pre-release
# version, and before this fix the detector said nothing about it at all: "no
# private-registry config and no pre-release pin" on a tree that plainly had one.
DETECT="$WORK/tool/detect-prerelease-pins.sh"
ctxproj="$WORK/agent-context-proj"
mkdir -p "$ctxproj/.metaobjects"
cat > "$ctxproj/.metaobjects/.agent-context.json" <<'JSON'
{
  "version": 1,
  "generatedBy": "1.1.0-rc.4",
  "servers": ["java"],
  "clients": [],
  "files": {}
}
JSON
if bash "$DETECT" "$ctxproj" >"$WORK/ctx-out" 2>&1; then
  fail "detect-prerelease-pins passes a tree whose agent context was generated by a pre-release CLI"
else
  pass "detect-prerelease-pins fails a tree whose agent context was generated by a pre-release CLI"
fi
check "it names the pre-release agent-context check" 'grep -q "agent context was generated by a pre-release CLI" "$WORK/ctx-out"'
check "it names the stamped version" 'grep -q "1.1.0-rc.4" "$WORK/ctx-out"'
check "it points at the release-CLI refresh command, not the registry unlink command" \
  'grep -q "meta init --refresh-docs --docs-only" "$WORK/ctx-out" && ! grep -q "prerelease-link.sh unlink" "$WORK/ctx-out"'

# A RELEASED generatedBy must not be flagged — the check is on the pre-release suffix,
# never on the key's mere presence.
cat > "$ctxproj/.metaobjects/.agent-context.json" <<'JSON'
{
  "version": 1,
  "generatedBy": "1.1.0",
  "servers": ["java"],
  "clients": [],
  "files": {}
}
JSON
if bash "$DETECT" "$ctxproj" >"$WORK/ctx-out-release" 2>&1; then
  pass "detect-prerelease-pins passes a tree whose agent context was generated by a RELEASE CLI"
else
  fail "detect-prerelease-pins failed a release-generated agent context: $(tail -5 "$WORK/ctx-out-release")"
fi

[ "$fails" -eq 0 ] || { echo "$fails failure(s)" >&2; exit 1; }
echo "all prerelease-link tests passed"
