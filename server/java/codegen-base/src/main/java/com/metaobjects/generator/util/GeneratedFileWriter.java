package com.metaobjects.generator.util;

import com.metaobjects.generator.GeneratorException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The write guard every Java and Kotlin generator goes through.
 *
 * <p><b>Why this exists.</b> {@code docs/features/codegen-concepts.md} §7 states a
 * product-wide safety backstop — <i>"the generator will not silently eat your work"</i> —
 * and every generator on these two ports was calling {@link Files#writeString} directly,
 * so the backstop was not implemented here at all. A file at a generated output path was
 * overwritten unconditionally, whatever it contained and whoever wrote it.
 *
 * <p><b>What it does.</b> The write decision comes from a committed HASH MANIFEST of what
 * {@code mvn metaobjects:generate} previously wrote — the same rule the TypeScript, Python
 * and C# ports already share — not from the {@code GENERATED} marker alone. The marker
 * rule it replaced was wrong in both directions: a hand-EDITED generated file keeps its
 * marker, so the one case worth protecting was overwritten silently; and a file this
 * generator wrote whose template later stopped emitting the marker was refused as though
 * it were somebody's hand-written source. The marker still matters at the ONE moment the
 * manifest cannot help: an existing file at a generated path that has never been recorded.
 * There, carrying the marker is what lets a pre-manifest file (adopted from before this
 * project committed {@code .metaobjects/.gen-state/.hashes.json}) be taken as this
 * toolchain's own rather than refused as hand-written — see {@link #write} for the full
 * decision tree. Absent any manifest configuration on the active {@link Run} (an embedder,
 * or a test driving a generator directly), the marker alone still decides, exactly as
 * before.
 *
 * <p>Each {@code <generator>} entry in the pom carries its own {@code handEdits} setting
 * ({@code keep}, the default, or {@code overwrite}, set via {@link Run#attributeTo(String,
 * String)}): {@code keep} refuses a hand-edited file by name; {@code overwrite} replaces it
 * with fresh output and re-baselines its recorded hash, printing one line per file so the
 * replacement is never silent. {@code overwrite} never applies to a file that was never
 * recorded as ours (a stranger) — only to a file the manifest shows this toolchain wrote.
 *
 * <p>Refusing is a WARNING, never a build failure. These generators run inside
 * {@code mvn metaobjects:generate}, where failing the reactor over a file the user chose
 * to own would punish exactly the person the guard is protecting.
 *
 * <p><b>WHAT THIS GUARD MUST NOT WRAP.</b> It only fits output whose header <i>we</i>
 * control, because "no marker ⇒ not ours" is sound only when our own emitters always
 * write the marker. These write paths deliberately bypass it, and re-routing them would
 * break them silently rather than loudly:
 *
 * <ul>
 *   <li>The {@code api-docs} generators' pages — rendered from {@code templates/api/*.mustache},
 *       which emit no marker and are under no obligation to.</li>
 *   <li>{@code TemplateScopeGenerator} — emits whatever a user's {@code --template-spec}
 *       renders (SQL, markdown, CSV); the content is not ours to require a marker of.</li>
 *   <li>{@code MustacheTemplateGenerator} — same reason: the body comes from a user-supplied
 *       mustache template, in an output format we do not choose.</li>
 *   <li>{@code JavaObjectCodeGenerator}'s {@code META-INF/services} registration — the file's
 *       entire content is a bare provider FQN, with nowhere to put a marker.</li>
 * </ul>
 *
 * <p>Guarding any of these made the FIRST run write and every run after refuse, so the artifact
 * froze while the build stayed green — the exact silent-staleness failure this class was
 * added to prevent, produced by the class itself. Before wrapping a new write site, check
 * that its emitter actually writes the marker.
 */
public final class GeneratedFileWriter {

    private static final Logger LOG = LoggerFactory.getLogger(GeneratedFileWriter.class);

    private GeneratedFileWriter() {}

    /** The token every generator on these ports emits in its file header. */
    public static final String GENERATED_MARKER = "GENERATED";

    /**
     * Where the marker is allowed to appear: at the start of a line, directly after
     * comment punctuation.
     *
     * <p>A bare {@code contains(GENERATED_MARKER)} was tolerant of every generator's
     * phrasing — which was the point — but it also failed OPEN in the other direction. A
     * hand-written file containing {@code // NOT GENERATED - hand-maintained}, an enum
     * member named {@code GENERATED}, or a javadoc sentence merely using the word all
     * read as this toolchain's output and got clobbered: the exact silent overwrite this
     * class exists to prevent, produced by its own guard.
     *
     * <p>Anchoring to the header SHAPE keeps the tolerance that matters — the prose after
     * the token still varies freely across generators — while excluding incidental
     * mentions: in {@code // NOT GENERATED} the token is not what follows the comment
     * punctuation, and an identifier has no comment punctuation before it at all.
     */
    private static final Pattern GENERATED_HEADER = Pattern.compile(
        "^[ \\t]*(?://+|/\\*+|\\*+)[ \\t]*" + GENERATED_MARKER + "\\b", Pattern.MULTILINE);

    /** Whether {@code content} carries this toolchain's generated-file header. */
    public static boolean looksGenerated(String content) {
        return GENERATED_HEADER.matcher(content).find();
    }

    /**
     * A multi-generator run, within which no output path may be claimed twice with
     * differing content.
     *
     * <p><b>Why this exists.</b> TypeScript and Python both refuse a conflicting duplicate
     * output path — {@code runner.ts} errors when two generators emit the same full path
     * with different content, and {@code run_gen} raises {@code Output path collision}.
     * Java has no runner: {@code MetaDataGeneratorMojo} simply calls {@code execute(loader)}
     * on each generator in turn, and each writes straight to disk, so nothing was in a
     * position to notice. The result was not theoretical. {@code entity} and
     * {@code value-object} both emit a Java type for an {@code object.value} at the same
     * path — a POJO class and a record, not variants of one thing — and whichever ran
     * second lost, leaving the adopter's DTO tier bound to a type that carries none of the
     * jakarta constraints it was built to validate. The only signal was a WARN.
     *
     * <p>Byte-identical re-emission is allowed, matching the TypeScript rule: a shared
     * artifact rendered once per entity is one file, not a conflict. Only DIFFERING content
     * at one path is a defect, because only then does the output depend on generator order.
     *
     * <p>Opt-in and thread-scoped. A caller that never opens a run — a test driving one
     * generator, an embedder — behaves exactly as before.
     */
    public static final class Run implements AutoCloseable {
        private final Map<Path, String> contentByPath = new HashMap<>();
        private final Map<Path, String> writerByPath = new HashMap<>();
        private String current = "(unattributed generator)";
        private String currentHandEdits = HAND_EDITS_KEEP;

        // Manifest configuration — unset (null genStateDir/projectRoot) means "no manifest
        // for this run", which keeps every write on the legacy marker-only rule. Set once,
        // by the Mojo, right after beginRun().
        private Path genStateDir;
        private Path projectRoot;
        private String owner;

        // Every path write() was asked to produce this run, whatever the outcome — written,
        // unchanged, refused or adopted. This is the "emitted" set the caller's orphan sweep
        // must not touch: a refused or adopted path is still spoken for.
        private final Set<Path> emittedPaths = new HashSet<>();
        // Aggregate state for the Mojo's end-of-run notices.
        private final List<String> adoptedPaths = new ArrayList<>();
        private final List<String> overwrittenHandEditedPaths = new ArrayList<>();
        private int untrackedCount = 0;

        private Run() {}

        /** Name the generator whose writes follow, with {@code handEdits=keep}. Equivalent
         *  to {@code attributeTo(generatorName, "keep")}. */
        public Run attributeTo(String generatorName) {
            return attributeTo(generatorName, HAND_EDITS_KEEP);
        }

        /**
         * Name the generator whose writes follow and its {@code handEdits} policy
         * ({@link #HAND_EDITS_KEEP} or {@link #HAND_EDITS_OVERWRITE}). Called once per
         * generator by the runner, before that generator executes.
         */
        public Run attributeTo(String generatorName, String handEdits) {
            this.current = generatorName;
            this.currentHandEdits = handEdits;
            return this;
        }

        /**
         * Turn on manifest-aware writes for this run: {@code genStateDir} is the directory
         * holding {@code .hashes.json} (typically {@code <basedir>/.metaobjects/.gen-state}),
         * {@code projectRoot} is what manifest keys are relative to (typically the module
         * basedir), and {@code owner} names the execution every path this run emits is
         * recorded against. Called once, by the Mojo, right after {@link #beginRun}. Leaving
         * this unset keeps every write on the legacy marker-only rule.
         */
        public Run configureManifest(Path genStateDir, Path projectRoot, String owner) {
            this.genStateDir = genStateDir;
            this.projectRoot = projectRoot;
            this.owner = owner;
            return this;
        }

        /** The files written, left in place, or adopted this run — the orphan sweep's
         *  "do not touch" set. */
        public Set<Path> emittedPaths() {
            return emittedPaths;
        }

        /** Project-relative paths adopted into a fresh manifest (or a manifest that had no
         *  record for them yet) this run — for the Mojo's one-time adoption notice. */
        public List<String> adoptedPaths() {
            return adoptedPaths;
        }

        /** Paths overwritten under {@code handEdits=overwrite} despite having been
         *  hand-edited since this toolchain last wrote them. */
        public List<String> overwrittenHandEditedPaths() {
            return overwrittenHandEditedPaths;
        }

        /** How many writes this run landed outside {@code projectRoot} and so could not be
         *  recorded in the manifest at all. */
        public int untrackedCount() {
            return untrackedCount;
        }

        private void claim(Path outFile, String content) {
            Path key = outFile.toAbsolutePath().normalize();
            String previous = contentByPath.get(key);
            if (previous == null) {
                contentByPath.put(key, content);
                writerByPath.put(key, current);
                return;
            }
            if (previous.equals(content)) {
                return; // same artifact, emitted twice — one file, no conflict
            }
            throw new GeneratorException(
                "Output path collision: " + key + " emitted by both '" + writerByPath.get(key)
                    + "' and '" + current + "' with different content. One of them would "
                    + "silently win depending on generator order, so neither is written. "
                    + "Select only one of these generators, or give one of them a different "
                    + "output directory.");
        }

        @Override
        public void close() {
            ACTIVE_RUN.remove();
        }
    }

    private static final ThreadLocal<Run> ACTIVE_RUN = new ThreadLocal<>();

    /**
     * Open a collision-checked run on this thread. Close it (try-with-resources) to end it.
     *
     * <p>Nesting is not supported and is not needed: the one caller that spans generators
     * is the runner, and a nested run would silently narrow the very scope the check needs.
     */
    public static Run beginRun() {
        Run run = new Run();
        ACTIVE_RUN.set(run);
        return run;
    }

    /** The open run on this thread, or {@code null}. */
    public static Run currentRun() {
        return ACTIVE_RUN.get();
    }

    /** {@link Run#attributeTo(String, String)}'s default: refuse a hand-edited file by name. */
    public static final String HAND_EDITS_KEEP = "keep";
    /** {@link Run#attributeTo(String, String)}: replace a hand-edited file with fresh output. */
    public static final String HAND_EDITS_OVERWRITE = "overwrite";

    /** What happened to one file. */
    public enum Outcome {
        /** Written — the path was new, held this toolchain's own output, or was adopted
         *  or overwritten per the active {@code handEdits} policy. */
        WRITTEN,
        /** Left alone — hand-written (or hand-edited under {@code handEdits=keep}). */
        REFUSED,
        /** Nothing to do — the file already holds exactly this content. */
        UNCHANGED
    }

    /**
     * Write {@code content} to {@code outFile} unless an existing file there is not ours,
     * creating parent directories as needed. Logs its own refusal.
     *
     * <p><b>No manifest configured on the active {@link Run}</b> (none open, or
     * {@link Run#configureManifest} was never called — an embedder, or a test driving a
     * generator directly): the legacy rule stands. A file that carries the
     * {@code GENERATED} marker is overwritten; one that does not is refused.
     *
     * <p><b>With a manifest</b> (the normal {@code mvn metaobjects:generate} path), per
     * file:
     * <ol>
     *   <li>absent → write, record its hash;</li>
     *   <li>exists, no record for this key yet → carries the marker? <b>adopt</b> it
     *       (write fresh content, record the hash) — this is how a file generated before
     *       this project committed a manifest, or by a generator just added to one, is
     *       taken as ours without a human having to say so. No marker → refused, exactly
     *       as always (a stranger, never touched regardless of {@code handEdits});</li>
     *   <li>exists, content already matches the fresh output → re-affirm the record,
     *       {@link Outcome#UNCHANGED};</li>
     *   <li>exists, recorded hash matches the current content (pristine) → overwrite,
     *       record the new hash;</li>
     *   <li>exists, recorded hash does NOT match (hand-edited since we wrote it) →
     *       {@code handEdits=keep} (default) refuses by name; {@code handEdits=overwrite}
     *       replaces it and re-baselines the record, logging the replacement.</li>
     * </ol>
     *
     * <p>A path outside the run's configured project root is never recorded (nothing to
     * key it by) and falls back to the marker-only rule, same as having no manifest at
     * all — the Mojo counts these via {@link Run#untrackedCount()}.
     *
     * <p>Throws {@link IOException} rather than wrapping it: every call site already sits
     * inside a {@code try/catch (IOException)} that raises a {@link GeneratorException}
     * naming the specific artifact. Swallowing it here would make those catches
     * unreachable — a compile error — and would replace each generator's precise message
     * with a generic one.
     */
    public static Outcome write(Path outFile, String content) throws IOException {
        Run run = ACTIVE_RUN.get();
        if (run != null) {
            run.emittedPaths.add(outFile.toAbsolutePath().normalize());
        }

        if (run == null || run.genStateDir == null) {
            return writeMarkerOnly(outFile, content, run);
        }

        String key = OrphanSweep.keyFor(run.projectRoot, outFile);
        if (key == null) {
            run.untrackedCount++;
            return writeMarkerOnly(outFile, content, run);
        }

        if (!Files.exists(outFile)) {
            performWrite(outFile, content, run);
            HashManifest.record(run.genStateDir, key, content, run.owner);
            return Outcome.WRITTEN;
        }

        String current = Files.readString(outFile, StandardCharsets.UTF_8);
        String recorded = HashManifest.recordedHash(run.genStateDir, key);

        if (recorded == null) {
            // Never recorded under this key. Marker present ⇒ this toolchain's own prior
            // output, from before a manifest existed (or before this generator's entry did)
            // — adopt it. No marker ⇒ hand-written, refused exactly as always; `handEdits`
            // never applies here, because a file never recorded as ours is not ours to
            // replace under any policy.
            if (looksGenerated(current)) {
                performWrite(outFile, content, run);
                HashManifest.record(run.genStateDir, key, content, run.owner);
                run.adoptedPaths.add(outFile.toString());
                return Outcome.WRITTEN;
            }
            LOG.warn(refusedMessage(outFile));
            return Outcome.REFUSED;
        }

        if (current.equals(content)) {
            // Nothing to write, but re-affirm the record: a first run over already-correct
            // output should leave the file recognised as ours next time.
            run.claim(outFile, content);
            HashManifest.record(run.genStateDir, key, content, run.owner);
            return Outcome.UNCHANGED;
        }

        if (recorded.equals(HashManifest.contentHash(current))) {
            // Pristine: matches what we last wrote, safe to overwrite with fresh content.
            performWrite(outFile, content, run);
            HashManifest.record(run.genStateDir, key, content, run.owner);
            return Outcome.WRITTEN;
        }

        // Edited: differs from both the fresh output and the last recorded hash.
        if (HAND_EDITS_OVERWRITE.equals(run.currentHandEdits)) {
            performWrite(outFile, content, run);
            HashManifest.record(run.genStateDir, key, content, run.owner);
            run.overwrittenHandEditedPaths.add(outFile.toString());
            LOG.warn("overwrote hand-edited " + outFile + " (handEdits: overwrite)");
            return Outcome.WRITTEN;
        }
        HashManifest.recordHash(run.genStateDir, key, recorded, run.owner);
        LOG.warn(refusedHandEditedMessage(outFile));
        return Outcome.REFUSED;
    }

    /** The legacy, manifest-less decision: overwrite a marker-bearing file, refuse any other. */
    private static Outcome writeMarkerOnly(Path outFile, String content, Run run) throws IOException {
        // The marker question comes FIRST, and a refusal returns before anything is
        // claimed. A path the adopter hand-owns is a path NO generator can write, so two
        // generators emitting different content there is not an order-dependent output —
        // there is no output. Claiming first threw a GeneratorException and killed the
        // build over a conflict that could not reach disk, contradicting this class's own
        // rule that refusing is a WARNING and never a build failure.
        if (Files.exists(outFile)
            && !looksGenerated(Files.readString(outFile, StandardCharsets.UTF_8))) {
            LOG.warn(refusedMessage(outFile));
            return Outcome.REFUSED;
        }
        performWrite(outFile, content, run);
        return Outcome.WRITTEN;
    }

    /**
     * Claim the path in the active run (the ordering/collision check — raised, never
     * warned, since an order-dependent output is not something the user can act on from a
     * log line) and write it to disk, creating parent directories as needed.
     */
    private static void performWrite(Path outFile, String content, Run run) throws IOException {
        if (run != null) {
            run.claim(outFile, content);
        }
        if (outFile.getParent() != null) {
            Files.createDirectories(outFile.getParent());
        }
        Files.writeString(outFile, content, StandardCharsets.UTF_8);
    }

    /**
     * The message shown when a file is refused.
     *
     * <p>It has to say what happened, why nothing was written, and how to get the
     * generated version back — an unexplained refusal invites deleting the file, which is
     * the outcome refusing exists to prevent.
     */
    public static String refusedMessage(Path outFile) {
        return "refusing to overwrite " + outFile + " — it carries no '" + GENERATED_MARKER
            + "' marker, so it is treated as hand-written and was left untouched. "
            + "If you want the generated version, move or delete this file and re-run.";
    }

    /**
     * The message shown when a file this toolchain DID previously write is refused because
     * it was edited since ({@code handEdits=keep}, the default).
     */
    public static String refusedHandEditedMessage(Path outFile) {
        return "refusing to overwrite " + outFile + " — it was edited since metaobjects "
            + "generated it, so it is treated as hand-edited and was left untouched "
            + "(handEdits: keep). Move your edits into a file of your own, delete this file and "
            + "re-run to accept the generated version, or set this generator's <handEdits> to "
            + "'overwrite' to have it replace hand edits automatically.";
    }
}
