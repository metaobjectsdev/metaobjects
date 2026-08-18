package com.metaobjects.generator.util;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * The write guard every Java and Kotlin generator goes through.
 *
 * <p><b>Why this exists.</b> {@code docs/features/codegen-concepts.md} §7 states a
 * product-wide safety backstop — <i>"the generator will not silently eat your work"</i> —
 * and every generator on these two ports was calling {@link Files#writeString} directly,
 * so the backstop was not implemented here at all. A file at a generated output path was
 * overwritten unconditionally, whatever it contained and whoever wrote it.
 *
 * <p><b>What it does, and deliberately does not do.</b> This is the marker floor, not
 * edit detection. A file that carries the {@code GENERATED} marker is this toolchain's
 * output and is overwritten; a file that does not is somebody's own and is refused. That
 * makes taking ownership of a generated file an explicit gesture: <b>delete the marker
 * line</b>, and regeneration will never touch the file again.
 *
 * <p>It cannot detect an edit to a file that KEEPS its marker — for that you need a
 * record of what was written, which is what the TypeScript port's committed hash manifest
 * provides. That machinery is deliberately not replicated here: these ports' customization
 * model is build-config and template-spec (see {@code docs/features/own-your-codegen.md},
 * "Per port"), not editing emitted files in place, so the accuracy it buys is not worth a
 * committed state file, a migration and a new class of merge conflict on ports whose
 * workflow does not ask for it. The same reasoning ADR-0015 applies to schema migrations:
 * shared where the guarantee is shared, per-port where the workflow differs.
 *
 * <p>Refusing is a WARNING, never a build failure. These generators run inside
 * {@code mvn metaobjects:generate}, where failing the reactor over a file the user chose
 * to own would punish exactly the person the guard is protecting.
 *
 * <p><b>WHAT THIS GUARD MUST NOT WRAP.</b> It only fits output whose header <i>we</i>
 * control, because "no marker ⇒ not ours" is sound only when our own emitters always
 * write the marker. Two write paths deliberately bypass it, and re-routing them would
 * break them silently rather than loudly:
 *
 * <ul>
 *   <li>{@code DocsMojo}'s API pages — rendered from {@code templates/api/*.mustache},
 *       which emit no marker and are under no obligation to.</li>
 *   <li>{@code TemplateScopeGenerator} — emits whatever a user's {@code --template-spec}
 *       renders (SQL, markdown, CSV); the content is not ours to require a marker of.</li>
 * </ul>
 *
 * <p>Guarding either made the FIRST run write and every run after refuse, so the artifact
 * froze while the build stayed green — the exact silent-staleness failure this class was
 * added to prevent, produced by the class itself. Before wrapping a new write site, check
 * that its emitter actually writes the marker.
 */
public final class GeneratedFileWriter {

    private static final Logger LOG = LoggerFactory.getLogger(GeneratedFileWriter.class);

    private GeneratedFileWriter() {}

    /**
     * The token every generator on these ports emits in its file header
     * ({@code GENERATED — …} / {@code // GENERATED — DO NOT EDIT — …}).
     *
     * <p>Matched as a plain substring rather than anchored to a line or column: the
     * header's surrounding prose differs per generator, and a guard that only recognises
     * one exact phrasing would silently fail open on the others — the failure mode this
     * whole class exists to remove.
     */
    public static final String GENERATED_MARKER = "GENERATED";

    /** What happened to one file. */
    public enum Outcome {
        /** Written — the path was new, or held this toolchain's own output. */
        WRITTEN,
        /** Left alone — the existing file carries no generated marker. */
        REFUSED
    }

    /**
     * Write {@code content} to {@code outFile} unless an existing file there is not ours,
     * creating parent directories as needed. Logs its own refusal.
     *
     * <p>Throws {@link IOException} rather than wrapping it: every call site already sits
     * inside a {@code try/catch (IOException)} that raises a {@link GeneratorException}
     * naming the specific artifact. Swallowing it here would make those catches
     * unreachable — a compile error — and would replace each generator's precise message
     * with a generic one.
     *
     * @return {@link Outcome#WRITTEN} or {@link Outcome#REFUSED}
     */
    public static Outcome write(Path outFile, String content) throws IOException {
        if (Files.exists(outFile)
            && !Files.readString(outFile, StandardCharsets.UTF_8).contains(GENERATED_MARKER)) {
            LOG.warn(refusedMessage(outFile));
            return Outcome.REFUSED;
        }
        if (outFile.getParent() != null) {
            Files.createDirectories(outFile.getParent());
        }
        Files.writeString(outFile, content, StandardCharsets.UTF_8);
        return Outcome.WRITTEN;
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
}
