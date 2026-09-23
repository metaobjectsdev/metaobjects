package com.metaobjects.mojo;

import org.apache.maven.model.Dependency;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.project.MavenProject;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * {@code mvn metaobjects:eject -Dnames=<a,b,...>} — copy one or more reference generators
 * into a new {@code codegen/} Maven module the adopter owns (FR — eject in every port, JVM
 * section; mirrors the TypeScript {@code meta eject} and the Python {@code metaobjects
 * eject}). {@code mvn metaobjects:eject -Dlist} prints the catalog instead of ejecting
 * (chosen over a separate {@code list} goal — one goal, one mental model, matching how
 * every other port's eject exposes its listing as a flag on the same command).
 *
 * <p><b>What it does.</b> For each requested stable name it resolves the generator (see
 * {@link EjectSupport#resolve}), reads its reference source from the classpath resource the
 * owning {@code codegen-spring}/{@code codegen-kotlin} jar ships it as, rewrites ONLY the
 * {@code package ...} declaration (ADR-0034: the package rename is the sole edit — a copy
 * that kept the reference's original package would silently lose to the plugin's own class,
 * since the project classloader is parent-first), and writes it under {@code
 * codegen/src/main/(java|kotlin)/<package path>/}. On first use it also writes {@code
 * codegen/pom.xml}.
 *
 * <p><b>What it never does.</b> It never edits the calling project's own {@code pom.xml} —
 * it PRINTS the {@code <module>}, the plugin {@code <dependency>}, and the {@code
 * <generator><classname>} change instead, the same reporting-not-editing stance ADR-0034 §3(c)
 * already rules for the TypeScript command. It never overwrites a file that exists unless
 * {@code -Dforce=true}. It validates every requested name BEFORE writing anything, so a bad
 * name in a multi-name call ejects nothing rather than half the batch.
 */
@Mojo(name = "eject", requiresProject = true, threadSafe = true)
public class MetaDataEjectMojo extends AbstractMojo {

    // Package-private (not private), matching AbstractMetaDataMojo's `project`/`execution`
    // convention: Maven sets these by reflection regardless of visibility, and it lets
    // same-package unit tests construct a Mojo directly and assign its parameters, the same
    // pattern NeutralConfigMojoFallbackTest / UseNamesDerivationTest already use.
    @Parameter(defaultValue = "${project}", readonly = true, required = true)
    MavenProject project;

    /** Comma-separated stable names to eject, e.g. {@code -Dnames=names,routes}. */
    @Parameter(property = "names")
    String names;

    /** Overwrite a file/pom that already exists. Without it, eject never clobbers. */
    @Parameter(property = "force", defaultValue = "false")
    boolean force;

    /** {@code java} or {@code kotlin} — required only when a requested name is ejectable
     *  on both ports and the calling project's dependencies don't disambiguate it. */
    @Parameter(property = "port")
    String port;

    /** Target package for ejected copies. Defaults to {@code <project.groupId>.codegen}. */
    @Parameter(property = "package")
    String targetPackage;

    /** Print the catalog (every ejectable name, and any owned copy's staleness) instead of
     *  ejecting. */
    @Parameter(property = "list", defaultValue = "false")
    boolean list;

    private static final String CODEGEN_DIR = "codegen";

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        if (list) {
            getLog().info(buildListOutput());
            return;
        }

        if (names == null || names.isBlank()) {
            throw new MojoFailureException(
                    "mvn metaobjects:eject requires -Dnames=<a,b,...>, or -Dlist=true to see "
                        + "what is ejectable.");
        }

        List<String> requested = List.of(names.split(",")).stream()
                .map(String::trim).filter(s -> !s.isEmpty()).distinct()
                .collect(Collectors.toList());
        if (requested.isEmpty()) {
            throw new MojoFailureException("mvn metaobjects:eject: -Dnames named nothing usable.");
        }

        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        EjectSupport.Port explicitPort = port == null || port.isBlank() ? null : EjectSupport.Port.parse(port);
        EjectSupport.Port inferredPort = EjectSupport.inferPort(declaredArtifactIds());

        // Validate EVERY name before writing ANY file — a partial eject over an unknown
        // name in the same call is worse than failing the whole call: it leaves a
        // half-changed repo whose re-run then reports the already-copied half as
        // "preserved", and the adopter cannot tell what happened.
        List<EjectSupport.Resolution> resolved = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        for (String n : requested) {
            EjectSupport.Resolution r = EjectSupport.resolve(n, catalog, explicitPort, inferredPort);
            resolved.add(r);
            if (!r.ok()) errors.add("  " + r.error);
        }
        if (!errors.isEmpty()) {
            throw new MojoFailureException(
                    "Nothing was ejected:\n" + String.join("\n", errors)
                        + "\nEjectable generators: " + String.join(", ", catalog.keySet()));
        }

        String pkg = (targetPackage == null || targetPackage.isBlank())
                ? project.getGroupId() + ".codegen" : targetPackage.trim();

        Path codegenRoot = project.getBasedir().toPath().resolve(CODEGEN_DIR);
        Set<EjectSupport.Port> portsTouched = new LinkedHashSet<>();
        List<String> classnameChanges = new ArrayList<>();

        for (EjectSupport.Resolution r : resolved) {
            EjectSupport.Entry e = r.entry;
            portsTouched.add(e.port);

            String reference;
            try {
                reference = readResource(e.resourcePath);
            } catch (IOException ex) {
                throw new MojoExecutionException(
                        "Could not read reference source for \"" + e.stableName + "\" at classpath "
                            + "resource " + e.resourcePath, ex);
            }
            String rewritten = EjectSupport.rewritePackage(reference, pkg);

            String langDir = e.port == EjectSupport.Port.KOTLIN ? "kotlin" : "java";
            Path pkgDir = codegenRoot.resolve("src/main/" + langDir).resolve(pkg.replace('.', '/'));
            Path target = pkgDir.resolve(e.simpleName() + "." + e.port.extension);

            reportEject(e, target, rewritten, write(pkgDir, target, rewritten, force));
            classnameChanges.add("  " + e.stableName + ": " + e.classname + "  ->  "
                    + pkg + "." + e.simpleName());
        }

        boolean pomWritten = writeCodegenPomIfNeeded(codegenRoot, pkg, portsTouched);

        printWiring(pomWritten, classnameChanges);
    }

    // ------------------------------------------------------------------------------------
    // writing
    // ------------------------------------------------------------------------------------

    private enum WriteStatus { CREATED, REPLACED, PRESERVED }

    private WriteStatus write(Path dir, Path target, String content, boolean force)
            throws MojoExecutionException {
        try {
            if (Files.exists(target)) {
                if (!force) return WriteStatus.PRESERVED;
                Files.writeString(target, content, StandardCharsets.UTF_8);
                return WriteStatus.REPLACED;
            }
            Files.createDirectories(dir);
            Files.writeString(target, content, StandardCharsets.UTF_8);
            return WriteStatus.CREATED;
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not write " + target, ex);
        }
    }

    private void reportEject(EjectSupport.Entry e, Path target, String rewritten, WriteStatus status)
            throws MojoExecutionException {
        switch (status) {
            case CREATED:
                getLog().info("Ejected \"" + e.stableName + "\" -> " + target
                        + ". You own it now (ADR-0034 scaffold-and-own).");
                break;
            case REPLACED:
                getLog().info("Ejected \"" + e.stableName + "\" -> " + target + ", REPLACING the file "
                        + "that was there (-Dforce=true).");
                break;
            case PRESERVED:
                try {
                    String existing = Files.readString(target, StandardCharsets.UTF_8);
                    EjectSupport.Comparison cmp = EjectSupport.compare(existing, rewritten);
                    if (cmp.verdict == EjectSupport.Verdict.IDENTICAL) {
                        getLog().info(target + " already exists and is IDENTICAL to the reference "
                                + "— nothing to do.");
                    } else {
                        getLog().info(target + " already exists and DIFFERS from the reference ("
                                + cmp.behind + " line(s) behind, " + cmp.ownedOnly + " line(s) of your "
                                + "own) — left untouched. Pass -Dforce=true to replace it (this "
                                + "DISCARDS your own lines).");
                    }
                } catch (IOException ex) {
                    throw new MojoExecutionException("Could not read existing " + target, ex);
                }
                break;
        }
    }

    /** Writes {@code codegen/pom.xml} only if absent (or {@code -Dforce=true}). Returns
     *  whether it wrote (vs. left an existing one alone). */
    private boolean writeCodegenPomIfNeeded(Path codegenRoot, String pkg, Set<EjectSupport.Port> ports)
            throws MojoExecutionException {
        Path pom = codegenRoot.resolve("pom.xml");
        if (Files.exists(pom) && !force) {
            getLog().info(pom + " already exists — left untouched (-Dforce=true replaces it).");
            return false;
        }
        String artifactId = project.getArtifactId() + "-codegen";
        String content = codegenPom(artifactId, ports);
        try {
            Files.createDirectories(codegenRoot);
            Files.writeString(pom, content, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not write " + pom, ex);
        }
        getLog().info("Wrote " + pom);
        return true;
    }

    /** The Java level the MetaObjects JVM artifacts are built for (the reactor's
     *  {@code java.version}); an ejected copy compiles against them. */
    static final String JAVA_RELEASE = "21";

    private String codegenPom(String artifactId, Set<EjectSupport.Port> ports) {
        String version = pluginVersion();
        StringBuilder deps = new StringBuilder();
        if (ports.contains(EjectSupport.Port.JAVA)) {
            deps.append("    <dependency>\n")
                .append("      <groupId>com.metaobjects</groupId>\n")
                .append("      <artifactId>metaobjects-codegen-spring</artifactId>\n")
                .append("      <version>").append(version).append("</version>\n")
                .append("    </dependency>\n");
        }
        if (ports.contains(EjectSupport.Port.KOTLIN)) {
            deps.append("    <dependency>\n")
                .append("      <groupId>com.metaobjects</groupId>\n")
                .append("      <artifactId>metaobjects-codegen-kotlin</artifactId>\n")
                .append("      <version>").append(version).append("</version>\n")
                .append("    </dependency>\n");
        }
        String kotlinPlugin = ports.contains(EjectSupport.Port.KOTLIN)
            ? "  <build>\n"
              + "    <sourceDirectory>src/main/kotlin</sourceDirectory>\n"
              + "    <plugins>\n"
              + "      <plugin>\n"
              + "        <groupId>org.jetbrains.kotlin</groupId>\n"
              + "        <artifactId>kotlin-maven-plugin</artifactId>\n"
              + "        <version>" + kotlin.KotlinVersion.CURRENT + "</version>\n"
              + "        <executions>\n"
              + "          <execution>\n"
              + "            <id>compile</id>\n"
              + "            <phase>compile</phase>\n"
              + "            <goals><goal>compile</goal></goals>\n"
              + "          </execution>\n"
              + "        </executions>\n"
              + "      </plugin>\n"
              + "    </plugins>\n"
              + "  </build>\n"
            : "";
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            + "<!-- Written by `mvn metaobjects:eject` (ADR-0034 scaffold-and-own). You own this\n"
            + "     module: rename it, add more ejected generators, edit their emit logic. Nothing\n"
            + "     here regenerates itself. -->\n"
            + "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
            + "  <modelVersion>4.0.0</modelVersion>\n"
            + "  <groupId>" + escape(project.getGroupId()) + "</groupId>\n"
            + "  <artifactId>" + escape(artifactId) + "</artifactId>\n"
            + "  <version>" + escape(project.getVersion()) + "</version>\n"
            + "  <packaging>jar</packaging>\n"
            // This module usually builds standalone, so nothing inherits a Java level. The
            // copies use Java 16+ syntax and compile against Java 21 jars; Maven's own
            // default is -source 8, and Kotlin's default JVM target is older still.
            + "  <properties>\n"
            + "    <maven.compiler.release>" + JAVA_RELEASE + "</maven.compiler.release>\n"
            + (ports.contains(EjectSupport.Port.KOTLIN)
                ? "    <kotlin.compiler.jvmTarget>" + JAVA_RELEASE + "</kotlin.compiler.jvmTarget>\n"
                : "")
            + "  </properties>\n"
            + "  <dependencies>\n"
            + deps
            + "  </dependencies>\n"
            + kotlinPlugin
            + "</project>\n";
    }

    private static String escape(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private void printWiring(boolean pomWritten, List<String> classnameChanges) {
        getLog().info("");
        if (pomWritten) {
            getLog().info("Add this module to the parent pom's <modules>:");
            getLog().info("  <module>" + CODEGEN_DIR + "</module>");
        }
        getLog().info("Add this dependency to the app module's metaobjects-maven-plugin <plugin>:");
        getLog().info("  <dependency>");
        getLog().info("    <groupId>" + project.getGroupId() + "</groupId>");
        getLog().info("    <artifactId>" + project.getArtifactId() + "-codegen</artifactId>");
        getLog().info("    <version>" + project.getVersion() + "</version>");
        getLog().info("  </dependency>");
        getLog().info("Change each ejected generator's <classname> in <generators>:");
        for (String c : classnameChanges) getLog().info(c);
    }

    // ------------------------------------------------------------------------------------
    // --list
    // ------------------------------------------------------------------------------------

    /**
     * Mirrors {@code server/python/src/metaobjects/cli.py}'s {@code LIST_HEADER} wording —
     * every generator here is a reference helper you own with {@code eject}, never a
     * guarantee (ADR-0034 Amendment 3).
     */
    private String buildListOutput() {
        StringBuilder sb = new StringBuilder();
        sb.append("Every generator below is a reference helper: it compiles and passes the "
                + "reference fixtures, and you own your copy once you run `mvn metaobjects:eject "
                + "-Dnames=<name>`. A defect in the reference is fixed there; a defect in your "
                + "copy is yours to fix.\n\n");

        Map<String, List<EjectSupport.Entry>> byName = new java.util.LinkedHashMap<>();
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            byName.computeIfAbsent(e.stableName, k -> new ArrayList<>()).add(e);
        }
        Path codegenRoot = project != null && project.getBasedir() != null
                ? project.getBasedir().toPath().resolve(CODEGEN_DIR) : null;

        for (Map.Entry<String, List<EjectSupport.Entry>> row : byName.entrySet()) {
            for (EjectSupport.Entry e : row.getValue()) {
                String tag = " [" + e.port.id + "]";
                if (e.resourcePath == null) {
                    sb.append("  ").append(row.getKey()).append(tag)
                            .append("  — not ejectable: ").append(e.description).append('\n');
                    continue;
                }
                String owned = ownedStaleness(codegenRoot, e);
                sb.append("  ").append(row.getKey()).append(tag).append("  — ").append(e.description);
                if (owned != null) sb.append("  ").append(owned);
                sb.append('\n');
            }
        }
        sb.append("\nRun: mvn metaobjects:eject -Dnames=<name>[,<name>...]");
        return sb.toString();
    }

    private String ownedStaleness(Path codegenRoot, EjectSupport.Entry e) {
        if (codegenRoot == null) return null;
        String langDir = e.port == EjectSupport.Port.KOTLIN ? "kotlin" : "java";
        // The owned copy may live under ANY package the adopter chose — search for a
        // file with this generator's simple name under codegen/src/main/<lang>.
        Path srcRoot = codegenRoot.resolve("src/main/" + langDir);
        if (!Files.isDirectory(srcRoot)) return null;
        String filename = e.simpleName() + "." + e.port.extension;
        try (var walk = Files.walk(srcRoot)) {
            Path found = walk.filter(p -> p.getFileName().toString().equals(filename))
                    .findFirst().orElse(null);
            if (found == null) return null;
            String owned = Files.readString(found, StandardCharsets.UTF_8);
            String reference = readResource(e.resourcePath);
            EjectSupport.Comparison cmp = EjectSupport.compare(owned, reference);
            return cmp.verdict == EjectSupport.Verdict.IDENTICAL
                    ? "[owned — identical]"
                    : "[owned — DIFFERS: " + cmp.behind + " behind, " + cmp.ownedOnly + " of your own]";
        } catch (IOException ex) {
            return "[owned — could not compare: " + ex.getMessage() + "]";
        }
    }

    // ------------------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------------------

    private List<String> declaredArtifactIds() {
        if (project == null || project.getDependencies() == null) return List.of();
        List<String> out = new ArrayList<>();
        for (Dependency d : project.getDependencies()) out.add(d.getArtifactId());
        return out;
    }

    private String readResource(String resourcePath) throws IOException {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(resourcePath)) {
            if (in == null) {
                throw new IOException("classpath resource not found: " + resourcePath);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** This plugin's own running version, for the {@code codegen/pom.xml} it writes —
     *  mirrors {@code AgentContextScaffold.installedVersion()}'s {@code pom.properties}
     *  read, scoped to this plugin's own coordinates. */
    private String pluginVersion() {
        String resource = "/META-INF/maven/com.metaobjects/metaobjects-maven-plugin/pom.properties";
        try (InputStream in = getClass().getResourceAsStream(resource)) {
            if (in == null) return FALLBACK_VERSION;
            Properties props = new Properties();
            props.load(in);
            String v = props.getProperty("version");
            return (v == null || v.isBlank()) ? FALLBACK_VERSION : v.trim();
        } catch (IOException e) {
            return FALLBACK_VERSION;
        }
    }

    /** Used only when this plugin's own {@code pom.properties} cannot be read (e.g. run
     *  from a non-packaged classpath, as in a unit test) — the printed wiring instructions
     *  tell the adopter to check the version regardless. */
    private static final String FALLBACK_VERSION = "LATEST-METAOBJECTS-VERSION";
}
