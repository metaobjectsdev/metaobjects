# Releasing the Java line to Maven Central

_Written from the **7.0.0** release (first publish from the consolidated
reactor at `server/java/`, 2026-05-27)._

## Companion doc

[`docs/RELEASING.md`](RELEASING.md) is TS / npm — different tooling, auth,
and gotchas. Each language ecosystem gets its own guide per the policy
documented there. Java tags are independent from TS (`v7.0.0` for Java; TS
is on a separate `0.x` track).

## What gets published

The reactor (`server/java/pom.xml`) lists 13 publishable modules. As of
7.0.0 the reactor explicitly **excludes** `archetype` and `examples` — they
were aggregator entries but not consumer-facing dependencies, and keeping
them in the reactor required `-pl` exclusions that didn't transitively
cover `examples/*` sub-modules under Maven 3.6.3. They still exist as
source directories (for scaffold + sample purposes) — just not built by
the reactor and not deployed.

| Module dir | Maven coords (`com.metaobjects:*`) |
|---|---|
| `metadata/` | `metaobjects-metadata` |
| `codegen-base/` | `metaobjects-codegen-base` |
| `codegen-mustache/` | `metaobjects-codegen-mustache` |
| `codegen-spring/` | `metaobjects-codegen-spring` |
| `codegen-kotlin/` | `metaobjects-codegen-kotlin` |
| `codegen-plantuml/` | `metaobjects-codegen-plantuml` |
| `render/` | `metaobjects-render` |
| `metadata-ktx/` | `metaobjects-metadata-ktx` |
| `om/` | `metaobjects-om` |
| `omdb/` | `metaobjects-omdb` |
| `omdb-ktx/` | `metaobjects-omdb-ktx` |
| `core-spring/` | `metaobjects-core-spring` |
| `maven-plugin/` | `metaobjects-maven-plugin` |

## Prerequisites (one-time, per machine)

The reactor's `release` profile uses:

1. **Central Portal credentials.** Get a User Token from
   <https://central.sonatype.com/account>. Add to `~/.m2/settings.xml`:

   ```xml
   <servers>
     <server>
       <id>central</id>
       <username>YOUR_USER_TOKEN_NAME</username>
       <password>YOUR_USER_TOKEN_VALUE</password>
     </server>
   </servers>
   ```

   `<id>central</id>` must match `publishingServerId` in the reactor pom's
   `central-publishing-maven-plugin` config.

2. **GPG signing key.** Maven Central requires signed JARs. The key used
   for 7.0.0 was generated batch-mode with `%no-protection` (no passphrase
   — operationally simplest; rotate via the revocation cert if it ever
   leaks). Generate with:

   ```bash
   cat > /tmp/gen.txt <<'EOF'
   %no-protection
   Key-Type: RSA
   Key-Length: 4096
   Key-Usage: sign
   Subkey-Type: RSA
   Subkey-Length: 4096
   Subkey-Usage: encrypt
   Name-Real: Douglas Mealing
   Name-Email: doug@dougmealing.com
   Expire-Date: 5y
   %commit
   EOF
   gpg --batch --generate-key /tmp/gen.txt && rm /tmp/gen.txt
   ```

   Upload the public half to all three keyservers Sonatype validates against:

   ```bash
   FP=<your-key-fingerprint>
   gpg --keyserver hkps://keys.openpgp.org      --send-keys $FP
   gpg --keyserver hkps://keyserver.ubuntu.com  --send-keys $FP
   gpg --keyserver hkps://pgp.mit.edu           --send-keys $FP
   ```

   Then back up `~/.gnupg/` + the revocation certificate in
   `~/.gnupg/openpgp-revocs.d/$FP.rev` to an offline location. **If you
   lose the secret key, the next release needs a new key + you lose
   key-continuity with prior releases.**

3. **GPG passphrase in settings.xml** — even when the key has no
   passphrase, the reactor pom interpolates `${gpg.passphrase}` so an
   empty property is required:

   ```xml
   <profiles>
     <profile>
       <id>gpg-credentials</id>
       <activation><activeByDefault>true</activeByDefault></activation>
       <properties>
         <gpg.passphrase></gpg.passphrase>
         <gpg.keyname>YOUR_KEY_FINGERPRINT</gpg.keyname>
       </properties>
     </profile>
   </profiles>
   ```

   For keys WITH a passphrase, drop the value in between the tags. CI-style
   `-Dgpg.passphrase=...` on the command line also works but is visible
   to process listings.

4. **`groupId` ownership.** `com.metaobjects` is already verified for the
   user token from steps 1–3. Verify in the Central Portal UI under
   Namespaces if you ever need to re-check.

## Procedure for a new release

### 1. Land all in-scope work on `main`

Confirm `main` is at the tip you want to release from, and run the full
reactor test suite — it should be green. (The `provider-extension-*`
conformance failures that the 7.0.0 release worked around with
`-DskipTests` were fixed during 7.1.0 prep; the deploy now runs the full
test gate — see step 5.)

### 2. Bump versions across the tree

```bash
cd server/java

# Reactor poms — versions:set only touches modules in <modules>.
mvn versions:set -DnewVersion=7.X.Y -DgenerateBackupPoms=false

# Non-reactor poms (integration-tests*, archetype, examples/*) declare
# <parent> refs and need a sed pass:
for f in integration-tests/pom.xml integration-tests-kotlin/pom.xml \
         archetype/pom.xml examples/pom.xml examples/basic-example/pom.xml \
         examples/osgi-example/pom.xml examples/shared-resources/pom.xml \
         examples/spring-example/pom.xml; do
  [ -f "$f" ] && sed -i 's|<version>PREV-VERSION</version>|<version>7.X.Y</version>|' "$f"
done

# Verify zero stragglers:
grep -rln '<version>PREV-VERSION<' . --include='pom.xml'   # should be empty
```

Commit the bump on `main`:

```bash
git add server/java
git commit -m "release(java): bump version to 7.X.Y"
git push origin main
```

### 3. Local smoke build

```bash
cd server/java && mvn clean install
```

All 13 publishable modules should reach SUCCESS with the full test suite green. The build also installs
locally into `~/.m2/repository/com/metaobjects/*/7.X.Y/`.

### 4. Tag the release

```bash
git tag -a v7.X.Y -m "metaobjects Java 7.X.Y — <one-line summary>"
git push origin v7.X.Y
```

### 5. Deploy to Central Portal

```bash
cd server/java
mvn clean deploy -P release -DperformRelease=true
```

The deploy runs the full reactor test suite — no `-DskipTests`. (The
provider-extension failures the 7.0.0 release skipped tests to avoid were
fixed in 7.1.0 prep.) A test failure aborts the build before any artifact
is published, which is the safe failure mode.

What the command does:

- Activates the `release` profile (triggered by `-DperformRelease=true`).
- Includes all 14 reactor modules (no `-pl` exclusions needed since
  archetype/examples are out of `<modules>`).
- Generates javadoc + sources jars for each module. **Kotlin modules use
  `dokka-maven-plugin` to produce javadoc** (added to each Kotlin pom
  during 7.0.0 prep) — `maven-javadoc-plugin` alone scans Java only and
  Central rejects deployments with missing javadoc jars.
- Signs every artifact via `maven-gpg-plugin`.
- Stages to the Central Portal via `central-publishing-maven-plugin`.
- Because `autoPublish: true` + `waitUntil: published`, the plugin waits
  until artifacts are LIVE on Central before returning.

Wall time: typically 1–3 min for the build + 3–10 min waiting on Central's
validation + publish. **Once `BUILD SUCCESS` prints, the artifacts are
LIVE and irreversible — no manual promotion step.**

### 6. Verify on Central

```bash
curl -s https://repo.maven.apache.org/maven2/com/metaobjects/metaobjects-metadata/maven-metadata.xml \
  | grep -E '<latest>|<release>'
# Expected:
#   <latest>7.X.Y</latest>
#   <release>7.X.Y</release>

curl -sI https://repo.maven.apache.org/maven2/com/metaobjects/metaobjects-metadata/7.X.Y/metaobjects-metadata-7.X.Y.jar | head -1
# Expected: HTTP/2 200
```

### 7. Post-release: bump to next SNAPSHOT

```bash
cd server/java
mvn versions:set -DnewVersion=7.X.Z-SNAPSHOT -DgenerateBackupPoms=false
# Same sed pass for non-reactor poms (step 2):
for f in integration-tests/pom.xml integration-tests-kotlin/pom.xml \
         archetype/pom.xml examples/pom.xml examples/basic-example/pom.xml \
         examples/osgi-example/pom.xml examples/shared-resources/pom.xml \
         examples/spring-example/pom.xml; do
  [ -f "$f" ] && sed -i 's|<version>7.X.Y</version>|<version>7.X.Z-SNAPSHOT</version>|' "$f"
done
git add server/java
git commit -m "chore(java): bump to 7.X.Z-SNAPSHOT post-7.X.Y"
git push origin main
```

## Lessons from the 7.0.0 publish

These are the actual non-obvious gotchas that surfaced during the first
deploy from the consolidated reactor:

- **`-pl '!examples'` does NOT transitively exclude `examples/*` children
  under Maven 3.6.3.** Either list every child explicitly
  (`-pl '!examples,!examples/basic-example,!examples/osgi-example,...'`)
  or remove the offending modules from the reactor entirely. 7.0.0 went
  with the latter — `archetype` and `examples` are no longer in the
  reactor's `<modules>` list.

- **Kotlin modules need Dokka for the javadoc jar.** Central's validation
  rejects any artifact without a javadoc.jar. `maven-javadoc-plugin` only
  scans Java sources, so Kotlin-only modules (`metadata-ktx`,
  `codegen-kotlin`, `omdb-ktx`) produce no jar without a Kotlin doc
  generator. `dokka-maven-plugin` (bound to the `package` phase via the
  `javadocJar` goal) fills the gap. Each of the three Kotlin modules has
  this plugin in their pom.

- **`-DskipTests` is no longer needed (fixed in 7.1.0).** The
  `provider-extension-*` conformance failures the 7.0.0 release skipped
  tests to avoid were greened during 7.1.0 prep, and the 7.1.0 deploy ran
  the full reactor test suite clean. Releases now run the full test gate
  at deploy time.

- **`autoPublish: true` means no staging review.** Once `mvn deploy`
  returns `BUILD SUCCESS`, the artifacts are LIVE on Central and cannot
  be deleted. To get a review window before going live, temporarily flip
  `autoPublish` to `false` in `server/java/pom.xml`, run the deploy,
  manually promote via the Central Portal UI, then revert.

- **Central reads from `repo.maven.apache.org` shortly after publish.**
  The plugin's `waitUntil: published` blocks until artifacts are visible
  there, so the post-deploy `curl` verification (step 6) returns 200
  immediately. If you skip `waitUntil`, you'd need to wait a few minutes
  before verifying.

- **Maven Central rejects empty javadoc.jars structurally.** A common
  workaround for Kotlin/no-Java modules is to attach an empty
  `-javadoc.jar` via `maven-jar-plugin` with `<forceCreation>true</forceCreation>`.
  We didn't test whether Central accepts that today — we went with Dokka
  for proper docs instead.
