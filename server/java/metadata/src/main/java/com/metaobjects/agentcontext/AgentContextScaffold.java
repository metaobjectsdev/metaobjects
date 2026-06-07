package com.metaobjects.agentcontext;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.function.Function;

/**
 * Scaffold planning + sidecar manifest for the agent-context writer.
 *
 * <p>Port of {@code server/typescript/packages/sdk/src/agent-context/scaffold.ts}
 * (and the Python {@code metaobjects.agent_context.scaffold}). Pure: all filesystem
 * access is via a {@code readCurrent} callback so the planning logic is testable
 * without touching disk.
 *
 * <p>A file is safe to overwrite iff it is absent, or its on-disk sha256 still
 * equals the hash the prior manifest recorded (the user hasn't hand-edited it). A
 * hand-edited file is preserved — the fresh contents go to {@code <path>.new}.
 */
public final class AgentContextScaffold {

    /** Consumer-relative path of the sidecar manifest that tracks scaffolded files. */
    public static final String MANIFEST_PATH = ".metaobjects/.agent-context.json";

    /**
     * Safe fallback when the installed version can't be resolved from the classpath
     * (mirrors the TS reference's {@code "0.0.0"} fallback). Compares unequal to any
     * real stamped version, so a real {@code generatedBy} always wins the equality
     * check — the nudge stays advisory, never spuriously asserting "in sync".
     */
    public static final String UNKNOWN_VERSION = "0.0.0";

    /** Maven group of the artifact carrying this class — used to find {@code pom.properties}. */
    private static final String MAVEN_GROUP_ID = "com.metaobjects";
    /** Maven artifact carrying this class — used to find {@code pom.properties}. */
    private static final String MAVEN_ARTIFACT_ID = "metaobjects-metadata";

    private AgentContextScaffold() {
    }

    /** A file to (over)write at its own path. */
    public record Write(String path, String contents) {
    }

    /** A hand-edited file: write the fresh contents to {@code newPath}, keep the original. */
    public record Conflict(String path, String newPath, String contents) {
    }

    /**
     * Tracks what the assembler last wrote, so re-runs can detect hand-edits.
     *
     * <p>{@code generatedBy} is the MetaObjects version that last scaffolded this agent
     * context. It is stamped so {@code gen}/{@code verify} can nudge a re-scaffold when
     * the installed version moves ahead (the skills/docs ship with the artifact, so an
     * upgrade can leave the copied-in context stale). It may be {@code null} for
     * back-compat with manifests written before version tracking existed (and for
     * cross-read manifests written by another port). Serialized as {@code "generatedBy"}
     * — the SAME key as the TS reference — so a polyglot repo can cross-read it.
     */
    public record Manifest(int version, String generatedBy, List<String> servers,
                           List<String> clients, Map<String, String> files) {
    }

    /** The outcome of planning a (re-)scaffold. */
    public record ScaffoldDecision(List<Write> writes, List<Conflict> conflicts,
                                   Manifest manifest, List<String> removed) {
    }

    /** sha256 hex of the UTF-8 bytes of {@code s} (matches the TS/Python digest). */
    public static String hashContents(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    /**
     * Decide what to write for a (re-)scaffold. Pure: filesystem access is via the
     * {@code readCurrent} function (returns the on-disk contents, or {@code null} if
     * absent).
     *
     * @param stack       the resolved consumer stack.
     * @param assembled   the assembler output for this stack.
     * @param prior       the prior manifest, or {@code null} for a fresh scaffold.
     * @param readCurrent reads the on-disk contents of a consumer-relative path, or
     *                    {@code null} if absent.
     * @param generatedBy the installed MetaObjects version doing the scaffold — stamped
     *                    into the manifest so later runs can nudge a stale re-scaffold.
     * @return the scaffold decision (writes, conflicts, manifest, removed).
     */
    public static ScaffoldDecision plan(Stack stack, List<AssembledFile> assembled,
                                        Manifest prior,
                                        Function<String, String> readCurrent,
                                        String generatedBy) {
        List<Write> writes = new ArrayList<>();
        List<Conflict> conflicts = new ArrayList<>();
        Map<String, String> files = new LinkedHashMap<>();

        for (AssembledFile f : assembled) {
            files.put(f.path(), hashContents(f.contents()));
            String current = readCurrent.apply(f.path());
            if (current == null) {
                writes.add(new Write(f.path(), f.contents()));
                continue;
            }
            String priorHash = prior != null ? prior.files().get(f.path()) : null;
            if (priorHash != null && hashContents(current).equals(priorHash)) {
                writes.add(new Write(f.path(), f.contents())); // unmodified → refresh
            } else {
                conflicts.add(new Conflict(f.path(), f.path() + ".new", f.contents()));
            }
        }

        java.util.Set<String> assembledPaths = new java.util.HashSet<>();
        for (AssembledFile f : assembled) {
            assembledPaths.add(f.path());
        }
        List<String> removed = new ArrayList<>();
        if (prior != null) {
            for (String p : prior.files().keySet()) {
                if (!assembledPaths.contains(p)) {
                    removed.add(p);
                }
            }
        }

        Manifest manifest = new Manifest(
                1,
                generatedBy,
                List.copyOf(stack.servers()),
                List.copyOf(stack.clients()),
                files);
        return new ScaffoldDecision(writes, conflicts, manifest, removed);
    }

    /**
     * A one-line nudge if the scaffolded agent context predates the installed MetaObjects
     * (so {@code gen}/{@code verify} can remind the user to refresh the skills after an
     * upgrade), or {@code null} when there is nothing to say — no agent context
     * scaffolded, or it is in sync.
     *
     * <p>Pure + advisory: never throws, never blocks, never writes. Direct port of the TS
     * {@code agentContextStaleness}. The equality check is EXACT on purpose — any drift
     * (including a prerelease/build-metadata difference) nudges, because a re-scaffold is
     * cheap + idempotent. Don't "fix" this into a semver compare.
     *
     * @param manifest       the parsed prior manifest, or {@code null} if none on disk.
     * @param currentVersion the installed MetaObjects version (see {@link #installedVersion()}).
     * @return the nudge message, or {@code null} when nothing needs saying.
     */
    public static String staleness(Manifest manifest, String currentVersion) {
        if (manifest == null) {
            return null; // no agent context here → nothing to nudge
        }
        if (currentVersion.equals(manifest.generatedBy())) {
            return null; // in sync
        }
        String from = manifest.generatedBy() != null ? manifest.generatedBy() : "an older MetaObjects";
        return "MetaObjects agent context was generated by " + from + "; you're on "
                + currentVersion + ". Re-run 'mvn metaobjects:agent-docs' to refresh "
                + "the .claude/skills docs.";
    }

    /**
     * The installed MetaObjects version, resolved the idiomatic Maven way: read
     * {@code /META-INF/maven/com.metaobjects/metaobjects-metadata/pom.properties} from the
     * classpath (Maven stamps this into the built jar). Falls back to
     * {@link #UNKNOWN_VERSION} when it can't be resolved (e.g. running from an exploded
     * classes dir in a test/IDE) — mirroring the TS reference's {@code "0.0.0"} fallback.
     * Never throws.
     *
     * @return the installed version, or {@link #UNKNOWN_VERSION}.
     */
    public static String installedVersion() {
        String resource = "/META-INF/maven/" + MAVEN_GROUP_ID + "/" + MAVEN_ARTIFACT_ID
                + "/pom.properties";
        try (InputStream in = AgentContextScaffold.class.getResourceAsStream(resource)) {
            if (in == null) {
                return UNKNOWN_VERSION;
            }
            Properties props = new Properties();
            props.load(in);
            String v = props.getProperty("version");
            return (v == null || v.isBlank()) ? UNKNOWN_VERSION : v.trim();
        } catch (Exception e) {
            return UNKNOWN_VERSION;
        }
    }
}
