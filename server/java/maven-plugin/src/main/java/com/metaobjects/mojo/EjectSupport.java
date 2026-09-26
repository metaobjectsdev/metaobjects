package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.kotlin.GeneratorInfo;
import com.metaobjects.generator.kotlin.GeneratorRegistryKt;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Shared engine behind {@code mvn metaobjects:eject} / {@code mvn metaobjects:eject -Dlist}
 * (FR — eject in every port, JVM section; ADR-0034 Amendment 3).
 *
 * <p>Deliberately Maven-free: every method here takes plain values (a catalog, a source
 * string, a declared-dependency set) rather than a {@link org.apache.maven.project.MavenProject}
 * or a {@code Log}, so the eject/list LOGIC is unit-testable without a Maven test harness.
 * {@link MetaDataEjectMojo} is the thin Maven-facing wrapper around this.
 */
public final class EjectSupport {

    private EjectSupport() {}

    /** Which JVM port a generator belongs to. */
    public enum Port {
        JAVA("java", "java"),
        KOTLIN("kotlin", "kt");

        public final String id;
        public final String extension;

        Port(String id, String extension) {
            this.id = id;
            this.extension = extension;
        }

        public static Port parse(String s) {
            if (s == null) return null;
            for (Port p : values()) {
                if (p.id.equalsIgnoreCase(s.trim())) return p;
            }
            throw new IllegalArgumentException(
                    "unknown -Dport '" + s + "'; expected 'java' or 'kotlin'");
        }
    }

    /** One ejectable generator, resolved from either port's registry. */
    public static final class Entry {
        public final Port port;
        public final String stableName;
        /** FQN as registered — the {@code <generator><classname>} value being replaced. */
        public final String classname;
        public final String description;
        public final String resourcePath;
        /** Simple names of the helper-runtime classes this generator's OUTPUT imports, which
         *  eject copies alongside it (empty for every Kotlin generator — see
         *  {@link #allEntries()}). */
        public final List<String> runtime;

        public Entry(Port port, String stableName, String classname, String description, String resourcePath) {
            this(port, stableName, classname, description, resourcePath, List.of());
        }

        public Entry(Port port, String stableName, String classname, String description,
                     String resourcePath, List<String> runtime) {
            this.port = port;
            this.stableName = stableName;
            this.classname = classname;
            this.description = description;
            this.resourcePath = resourcePath;
            this.runtime = List.copyOf(runtime);
        }

        /** The simple class name — also the filename stem the ejected copy is written as. */
        public String simpleName() {
            int dot = classname.lastIndexOf('.');
            return dot < 0 ? classname : classname.substring(dot + 1);
        }
    }

    /**
     * Every generator BOTH registries declare, ejectable or not (an entry with a {@code
     * null} {@link Entry#resourcePath} is registered but not ejectable — see {@code
     * GeneratorRegistry}'s "extractor"/"template" javadoc). Insertion order: Java first,
     * then Kotlin, each in its own registry's declared order.
     *
     * <p>Only Java entries carry helper runtime. The Kotlin generators emit their filter
     * parsing, constraint mapping and patch handling INLINE in each generated file, and
     * import nothing but core ({@code com.metaobjects.render.*}, the loader,
     * {@code metadata-ktx}) — so there is nothing for a Kotlin eject to hand over.
     * {@code EjectRuntimeRoundTripTest} asserts that against real Kotlin output.
     */
    public static List<Entry> allEntries() {
        List<Entry> out = new ArrayList<>();
        for (GeneratorRegistry.GeneratorInfo info : GeneratorRegistry.list().values()) {
            out.add(new Entry(Port.JAVA, info.stableName(), info.classname(), info.description(),
                    info.ejectResourcePath(), info.ejectRuntime()));
        }
        for (Map.Entry<String, GeneratorInfo> e : GeneratorRegistryKt.getGENERATOR_REGISTRY().entrySet()) {
            GeneratorInfo info = e.getValue();
            // Kotlin generator classes have no separate public "classname" string field —
            // the registry's factory closure is what constructs them — so the FQN is
            // derived from the package plus the stable resource filename (both ports name
            // the ejectable resource after the class's simple name, e.g.
            // "KotlinNamesGenerator.kt" <-> class KotlinNamesGenerator).
            String simple = info.getEjectResourcePath() == null ? null
                    : simpleNameFromResource(info.getEjectResourcePath());
            String classname = simple == null ? null
                    : "com.metaobjects.generator.kotlin." + simple;
            out.add(new Entry(Port.KOTLIN, info.getName(), classname, info.getDescription(),
                    info.getEjectResourcePath()));
        }
        return out;
    }

    private static String simpleNameFromResource(String resourcePath) {
        String file = resourcePath.substring(resourcePath.lastIndexOf('/') + 1);
        int dot = file.lastIndexOf('.');
        return dot < 0 ? file : file.substring(0, dot);
    }

    /** Only the ejectable entries (non-null {@link Entry#resourcePath}), grouped by stable name. */
    public static Map<String, List<Entry>> ejectableByStableName() {
        Map<String, List<Entry>> byName = new LinkedHashMap<>();
        for (Entry e : allEntries()) {
            if (e.resourcePath == null) continue;
            byName.computeIfAbsent(e.stableName, k -> new ArrayList<>()).add(e);
        }
        return byName;
    }

    /** How one requested name resolved — exactly one entry, or a reason it could not. */
    public static final class Resolution {
        public final String name;
        public final Entry entry;   // non-null on success
        public final String error;  // non-null on failure

        private Resolution(String name, Entry entry, String error) {
            this.name = name;
            this.entry = entry;
            this.error = error;
        }

        public boolean ok() { return entry != null; }
    }

    /**
     * Resolve one requested stable name against the ejectable catalog.
     *
     * @param explicitPort {@code -Dport}, or {@code null}
     * @param inferredPort the port inferred from the calling project's declared
     *      dependencies (see {@link #inferPort}), or {@code null}
     */
    public static Resolution resolve(String name, Map<String, List<Entry>> byName,
                                     Port explicitPort, Port inferredPort) {
        List<Entry> candidates = byName.get(name);
        if (candidates == null || candidates.isEmpty()) {
            return new Resolution(name, null, "unknown generator \"" + name + "\"");
        }
        if (candidates.size() == 1) {
            return new Resolution(name, candidates.get(0), null);
        }
        // Ambiguous: the same stable name is ejectable on more than one port.
        Port winner = explicitPort != null ? explicitPort : inferredPort;
        if (winner == null) {
            String ports = candidates.stream().map(c -> c.port.id).collect(Collectors.joining(", "));
            return new Resolution(name, null,
                    "\"" + name + "\" is ejectable on more than one port (" + ports + "). "
                        + "Pass -Dport=java|kotlin, or eject after your project declares a "
                        + "dependency on metaobjects-codegen-spring or metaobjects-codegen-kotlin "
                        + "so it can be inferred.");
        }
        for (Entry c : candidates) {
            if (c.port == winner) return new Resolution(name, c, null);
        }
        return new Resolution(name, null,
                "\"" + name + "\" is not ejectable on port '" + winner.id + "' (only on: "
                    + candidates.stream().map(c -> c.port.id).collect(Collectors.joining(", ")) + ")");
    }

    /**
     * Infer the port from a project's declared dependency artifactIds: exactly one of
     * {@code metaobjects-codegen-spring} / {@code metaobjects-codegen-kotlin} present, in
     * either order. Returns {@code null} (no inference) when neither or both are declared.
     */
    public static Port inferPort(List<String> declaredArtifactIds) {
        boolean java = declaredArtifactIds.contains("metaobjects-codegen-spring");
        boolean kotlin = declaredArtifactIds.contains("metaobjects-codegen-kotlin");
        if (java && !kotlin) return Port.JAVA;
        if (kotlin && !java) return Port.KOTLIN;
        return null;
    }

    // ------------------------------------------------------------------------------------
    // package rewrite — the ONE edit a copy gets (ADR-0034; the JVM eject design's "the
    // package rename is the only edit").
    // ------------------------------------------------------------------------------------

    private static final Pattern PACKAGE_LINE = Pattern.compile("(?m)^package\\s+[\\w.]+\\s*;?\\s*$");

    /**
     * Rewrite the FIRST {@code package ...} line of {@code source} to {@code newPackage},
     * preserving the source's own punctuation (Java's trailing {@code ;}, Kotlin's lack of
     * one). Every ejectable reference file declares its package as literally its first
     * non-comment/non-blank statement, so replacing the first match is unambiguous.
     */
    public static String rewritePackage(String source, String newPackage) {
        Matcher m = PACKAGE_LINE.matcher(source);
        if (!m.find()) {
            throw new IllegalStateException("reference source has no 'package ...' line to rewrite");
        }
        boolean semicolon = m.group().stripTrailing().endsWith(";");
        String replacement = "package " + newPackage + (semicolon ? ";" : "");
        return new StringBuilder(source).replace(m.start(), m.end(), replacement).toString();
    }

    // ------------------------------------------------------------------------------------
    // helper runtime — the source a generator's OUTPUT imports, handed over with it
    // ------------------------------------------------------------------------------------

    /** The declaration an ejectable Java generator names its runtime package in. Eject
     *  rewrites this one line so the owned generator's output imports the owned runtime. */
    private static final Pattern RUNTIME_PACKAGE_DECL = Pattern.compile(
            "(?m)^(\\s*public static final String RUNTIME_PACKAGE = )\"[\\w.]+\";\\s*$");

    /**
     * The first line of every runtime file eject writes. It is how {@code metaobjects:verify}
     * tells an owned runtime file from a stale generated one when the two share an output
     * directory, and how {@code -Dlist} finds the copies. Keep it if you move the file.
     */
    public static final String OWNED_RUNTIME_MARKER = "// metaobjects:owned-runtime";

    /** Point an ejected generator's {@code RUNTIME_PACKAGE} at {@code runtimePackage}. A
     *  source with no such declaration (a generator whose output imports no runtime) is
     *  returned unchanged. */
    public static String rewriteRuntimePackage(String source, String runtimePackage) {
        Matcher m = RUNTIME_PACKAGE_DECL.matcher(source);
        if (!m.find()) return source;
        String replacement = m.group(1) + "\"" + runtimePackage + "\";";
        return new StringBuilder(source).replace(m.start(), m.end(), replacement).toString();
    }

    /**
     * The owned copy of one runtime class: its package renamed to {@code runtimePackage}, and
     * the {@link #OWNED_RUNTIME_MARKER} line (naming the reference it came from) on top.
     * Nothing else changes.
     */
    public static String ownedRuntimeSource(String reference, String simpleName, String runtimePackage) {
        return OWNED_RUNTIME_MARKER + " — copied by `mvn metaobjects:eject` from "
                + GeneratorRegistry.RUNTIME_PACKAGE + "." + simpleName
                + ". You own this file.\n"
                + rewritePackage(reference, runtimePackage);
    }

    /** Whether {@code content} is a runtime file eject wrote (its marker is on the first
     *  non-blank line). */
    public static boolean isOwnedRuntime(String content) {
        for (String line : content.split("\n", -1)) {
            String t = line.strip();
            if (t.isEmpty()) continue;
            return t.startsWith(OWNED_RUNTIME_MARKER);
        }
        return false;
    }

    /** Every runtime class the given entries' output imports, in first-seen order. */
    public static List<String> runtimeFor(List<Entry> entries) {
        Set<String> out = new LinkedHashSet<>();
        for (Entry e : entries) out.addAll(e.runtime);
        return new ArrayList<>(out);
    }

    // ------------------------------------------------------------------------------------
    // owned-copy comparison — line-multiset, ignoring the package line (mirrors Python's
    // metaobjects.codegen.eject._normalised / owned_status).
    // ------------------------------------------------------------------------------------

    public enum Verdict { IDENTICAL, DIFFERS }

    public static final class Comparison {
        public final Verdict verdict;
        /** Lines the reference has that the owned copy does not — how far behind it is. */
        public final int behind;
        /** Lines the owned copy has that the reference does not — the adopter's own edits. */
        public final int ownedOnly;

        Comparison(Verdict verdict, int behind, int ownedOnly) {
            this.verdict = verdict;
            this.behind = behind;
            this.ownedOnly = ownedOnly;
        }
    }

    /** Every non-blank line, trimmed, with the lines eject itself writes dropped — the
     *  package line, a generator's {@code RUNTIME_PACKAGE} declaration and a runtime file's
     *  ownership marker are the deliberate edits of eject, not drift. */
    private static List<String> normalizedLines(String source) {
        List<String> out = new ArrayList<>();
        for (String line : source.split("\n", -1)) {
            String t = line.strip();
            if (t.isEmpty()) continue;
            if (PACKAGE_LINE.matcher(t).matches()) continue;
            if (RUNTIME_PACKAGE_DECL.matcher(t).matches()) continue;
            if (t.startsWith(OWNED_RUNTIME_MARKER)) continue;
            out.add(t);
        }
        return out;
    }

    public static Comparison compare(String owned, String reference) {
        List<String> a = normalizedLines(owned);
        List<String> b = normalizedLines(reference);
        Map<String, Integer> refCounts = new LinkedHashMap<>();
        for (String l : b) refCounts.merge(l, 1, Integer::sum);
        int ownedOnly = 0;
        Map<String, Integer> remaining = new LinkedHashMap<>(refCounts);
        for (String l : a) {
            Integer n = remaining.get(l);
            if (n != null && n > 0) {
                remaining.put(l, n - 1);
            } else {
                ownedOnly++;
            }
        }
        int behind = remaining.values().stream().mapToInt(Integer::intValue).sum();
        return new Comparison(behind == 0 && ownedOnly == 0 ? Verdict.IDENTICAL : Verdict.DIFFERS,
                behind, ownedOnly);
    }
}
