#!/usr/bin/env bash
# Tests for tools/prerelease/prerelease-link.sh — the two defects an adopter hit linking a project
# to a pre-release candidate.
#
#   tools/prerelease/test-prerelease-link.sh
#
# D9  the Maven pin is npm major + 7 (1.1.0-rc.N is 8.1.0-rc.N), not a hardcoded 7.
# D11 in a linked git worktree the exclude file is the shared one in the common dir, nothing
#     stray is written into the work tree, and `link` refuses to report success while a written
#     .npmrc (which can hold a registry credential) is not ignored.
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
git -C "$poly" add -A && git -C "$poly" commit -q -m init
if link "$poly"; then pass "link succeeds in a polyglot repository"; else fail "polyglot link failed: $(tail -5 "$WORK/out")"; fi
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

MO_REGISTRY_BASE="http://127.0.0.1:$PORT" MO_REGISTRY_OWNER=owner MO_REGISTRY_TOKEN="" \
  bash "$LINK" unlink --project "$poly" --to 1.0.13 >"$WORK/out" 2>&1 || true
check "an inherited version property survives link and unlink" 'grep -q "<version>\${metaobjects.version}</version>" "$poly/ports/java/inherits/pom.xml" && ! grep -q "<version>8" "$poly/ports/java/inherits/pom.xml"'
check "unlink removes every managed block" '! grep -rq "metaobjects prerelease (managed)" "$poly/ports"'
check "unlink repins the nested python project" 'grep -q "metaobjects==1.0.13" "$poly/ports/python/pyproject.toml"'
check "unlink repins every pom" 'grep -q "8.0.13" "$poly/ports/java/pom.xml" && grep -q "8.0.13" "$poly/ports/java/module/pom.xml" && [ "$(grep -c "<version>8.0.13</version>" "$poly/ports/kotlin/pom.xml")" = 3 ]'
check "unlink repins the local tool" 'grep -q "\"metaobjects.cli\": { \"version\": \"1.0.13\"" "$poly/.config/dotnet-tools.json"'
check "unlink removes every .mvn workaround" '[ ! -e "$poly/ports/java/.mvn" ] && [ ! -e "$poly/ports/kotlin/.mvn" ]'

[ "$fails" -eq 0 ] || { echo "$fails failure(s)" >&2; exit 1; }
echo "all prerelease-link tests passed"
