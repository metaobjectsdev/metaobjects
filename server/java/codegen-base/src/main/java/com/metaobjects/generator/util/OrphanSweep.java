package com.metaobjects.generator.util;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * The orphan sweep: delete a file {@code mvn metaobjects:generate} wrote earlier and no
 * longer generates.
 *
 * <p>The rule every port shares (TypeScript's {@code runner.ts}/{@code orphan-sweep.ts},
 * Python's {@code codegen/orphan_sweep.py}, C#'s {@code OrphanSweep.cs}):
 *
 * <ul>
 *   <li>A candidate is a file under an output directory of a FULL run that the hash
 *       manifest records writing and that no generator of the run emitted this time.
 *       A file the manifest does not record is not ours, whatever its name, and is
 *       never touched (a {@link Verdict#STRANGER}).</li>
 *   <li>On the JVM a candidate must also be OWNED by the sweeping execution: two
 *       {@code <execution>}s of one module share the manifest and may share an output
 *       directory, so a file another execution recorded, or one recorded with no owner
 *       at all, is never this execution's orphan.</li>
 *   <li>A file is judged once, by the innermost swept directory that holds it, so a
 *       directory nested in another is judged by its own generators' policy.</li>
 *   <li>An untouched candidate ({@link Verdict#PRISTINE} — its content still hashes to
 *       what was recorded) is deleted and its manifest entry dropped.</li>
 *   <li>An edited candidate ({@link Verdict#EDITED}) is, by default, REFUSED by name and
 *       stays recorded, so the refusal repeats until someone deletes the file or moves
 *       the edits — unless the directory it lives under is entirely owned by generators
 *       whose {@code handEdits} setting is {@code overwrite}, in which case it is deleted
 *       too (there being no record of which generator wrote an orphan, {@code overwrite}
 *       only applies when EVERY generator writing into that directory this run agrees).</li>
 *   <li>A recorded path whose file is already gone is forgotten.</li>
 * </ul>
 *
 * <p>{@code metaobjects:verify} convicts an extra committed file on the same evidence
 * ({@link #classify}), so {@code generate} removes exactly the untouched files the gate
 * reports, which is what makes the gate's "regenerate" remedy work.
 */
public final class OrphanSweep {

    private OrphanSweep() {}

    /** How a committed file relates to the manifest. */
    public enum Verdict {
        /** Not recorded: never ours, never touched. */
        STRANGER,
        /** Recorded and byte-for-byte what was recorded: safe to delete/overwrite. */
        PRISTINE,
        /** Recorded but its content has changed since: hand-edited. */
        EDITED
    }

    /** One directory a run's generators wrote into. */
    public static final class Entry {
        public final Path dir;
        /** Prefix shown before a dir-relative path when reporting a file under this dir. */
        public final String label;
        /** True iff every generator that writes into this dir this run has {@code handEdits=overwrite}. */
        public final boolean allowOverwrite;

        public Entry(Path dir, String label, boolean allowOverwrite) {
            this.dir = dir;
            this.label = label;
            this.allowOverwrite = allowOverwrite;
        }
    }

    /** The outcome of one sweep. */
    public static final class Result {
        /** Pristine orphans deleted, as shown (label + dir-relative path). */
        public final List<String> removed;
        /** Edited orphans deleted because their directory's generators are all {@code overwrite}. */
        public final List<String> overwrittenDeleted;
        /** Project-relative keys of edited orphans left in place (handEdits=keep). */
        public final List<String> refused;

        public Result(List<String> removed, List<String> overwrittenDeleted, List<String> refused) {
            this.removed = removed;
            this.overwrittenDeleted = overwrittenDeleted;
            this.refused = refused;
        }
    }

    /**
     * The project-root-relative, forward-slash key for {@code file}, or {@code null} when
     * {@code file} lies outside {@code projectRoot} — nothing outside the project is ever
     * recorded, so nothing outside it can be classified.
     */
    public static String keyFor(Path projectRoot, Path file) {
        Path root = projectRoot.toAbsolutePath().normalize();
        Path full = file.toAbsolutePath().normalize();
        Path rel;
        try {
            rel = root.relativize(full);
        } catch (IllegalArgumentException e) {
            return null; // different filesystem roots (Windows drives) — definitely outside
        }
        String key = rel.toString().replace(java.io.File.separatorChar, '/');
        return key.startsWith("..") ? null : key;
    }

    /**
     * Classify one committed file against the manifest: not recorded ({@link Verdict#STRANGER}),
     * recorded and unchanged ({@link Verdict#PRISTINE}), or recorded and changed
     * ({@link Verdict#EDITED}). An unreadable file that IS recorded reads as edited —
     * fail closed, never silently dropped.
     */
    public static Verdict classify(Map<String, String> hashes, Path projectRoot, Path file) {
        String key = keyFor(projectRoot, file);
        if (key == null) return Verdict.STRANGER;
        String recorded = hashes.get(key);
        if (recorded == null) return Verdict.STRANGER;
        String current;
        try {
            current = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return Verdict.EDITED;
        }
        return recorded.equals(HashManifest.contentHash(current)) ? Verdict.PRISTINE : Verdict.EDITED;
    }

    /**
     * Delete the untouched files under {@code dirs} that the manifest records as written
     * by {@code owner} and {@code emitted} (normalized absolute paths this run produced,
     * refused hand-edits included) does not hold, and forget every path recorded for
     * {@code owner} under those directories whose file is already gone. No-op (empty
     * result, manifest untouched) when the project has no manifest yet — there is nothing
     * recorded, so nothing could be an orphan.
     */
    public static Result sweep(Path genStateDir, Path projectRoot, List<Entry> dirs, Set<Path> emitted,
                               String owner) {
        if (!HashManifest.exists(genStateDir)) {
            return new Result(List.of(), List.of(), List.of());
        }
        Map<String, String> hashes = HashManifest.load(genStateDir);
        Map<String, String> owners = HashManifest.loadOwners(genStateDir);
        Set<String> forget = new LinkedHashSet<>();
        List<String> removed = new ArrayList<>();
        List<String> overwrittenDeleted = new ArrayList<>();
        List<String> refused = new ArrayList<>();
        Path root = projectRoot.toAbsolutePath().normalize();

        // De-dupe by normalized directory — two generators sharing an outputDir supply
        // the same Entry twice; only its first (any, since dirs sharing a path carry the
        // same allowOverwrite — callers build Entry per unique dir) is needed.
        Map<Path, Entry> byDir = new LinkedHashMap<>();
        for (Entry e : dirs) {
            byDir.putIfAbsent(e.dir.toAbsolutePath().normalize(), e);
        }

        for (Entry e : byDir.values()) {
            Path full = e.dir.toAbsolutePath().normalize();
            String prefix = keyFor(root, full);
            if (prefix == null) continue; // nothing outside the project is ours to delete
            List<Path> nested = byDir.keySet().stream()
                    .filter(d -> !d.equals(full) && d.startsWith(full))
                    .collect(Collectors.toList());

            if (Files.isDirectory(full)) {
                List<Path> files;
                try (Stream<Path> walk = Files.walk(full)) {
                    files = walk.filter(Files::isRegularFile).collect(Collectors.toList());
                } catch (IOException ex) {
                    throw new UncheckedIOException("Could not walk generated output dir [" + full + "]", ex);
                }
                for (Path file : files) {
                    Path normFile = file.toAbsolutePath().normalize();
                    if (emitted.contains(normFile) || isUnder(normFile, nested)) continue;
                    String key = keyFor(root, normFile);
                    if (key == null || !hashes.containsKey(key)) continue; // stranger — not ours
                    if (!owner.equals(owners.get(key))) continue; // another execution's, or unowned

                    String relDisplay = full.relativize(normFile).toString().replace(java.io.File.separatorChar, '/');
                    Verdict verdict = classify(hashes, root, normFile);
                    switch (verdict) {
                        case PRISTINE:
                            delete(normFile);
                            forget.add(key);
                            removed.add(e.label + relDisplay);
                            break;
                        case EDITED:
                            if (e.allowOverwrite) {
                                delete(normFile);
                                forget.add(key);
                                overwrittenDeleted.add(e.label + relDisplay);
                            } else {
                                refused.add(key);
                            }
                            break;
                        case STRANGER:
                        default:
                            // Already excluded above by the hashes.containsKey() check.
                            break;
                    }
                }
            }

            // Recorded under this directory, not emitted, and already gone: forget it, so a
            // stranger's file created later under that name is not mistaken for ours.
            String under = prefix.isEmpty() ? "" : prefix + "/";
            for (String key : hashes.keySet()) {
                if (!key.startsWith(under) || !owner.equals(owners.get(key))) continue;
                Path path = root.resolve(key).normalize();
                if (emitted.contains(path) || isUnder(path, nested) || Files.exists(path)) continue;
                forget.add(key);
            }
        }

        if (!forget.isEmpty()) {
            Map<String, String> updated = new LinkedHashMap<>(hashes);
            for (String key : forget) updated.remove(key);
            HashManifest.save(genStateDir, updated, owners);
        }

        removed.sort(String::compareTo);
        overwrittenDeleted.sort(String::compareTo);
        List<String> distinctRefused = refused.stream().distinct().sorted().collect(Collectors.toList());
        return new Result(removed, overwrittenDeleted, distinctRefused);
    }

    private static boolean isUnder(Path path, List<Path> dirs) {
        for (Path d : dirs) {
            if (path.startsWith(d)) return true;
        }
        return false;
    }

    private static void delete(Path path) {
        try {
            Files.delete(path);
        } catch (IOException ex) {
            throw new UncheckedIOException("Could not delete orphaned generated file [" + path + "]", ex);
        }
    }

    /**
     * The aggregate warning for edited orphans left in place (handEdits=keep). The same
     * wording, shared verbatim with codegen-ts's {@code refusedOrphanMessage}, Python's
     * {@code refused_orphan_message} and C#'s {@code OrphanSweep.RefusedMessage}: what
     * happened, why nothing was deleted, and the two ways out.
     */
    public static String refusedMessage(List<String> paths, String owner) {
        return owner + ": " + paths.size() + " generated file(s) are no longer generated but have been "
            + "edited by hand, so they were NOT deleted: " + String.join(", ", paths) + ". Delete each "
            + "one, or, if what produced it was renamed, move your edits into the newly generated file "
            + "first and then delete it (regeneration cannot follow a rename).";
    }

    /** The per-file notice for an edited orphan deleted under {@code handEdits=overwrite}. */
    public static String overwrittenOrphanMessage(String path) {
        return "deleted hand-edited " + path + ", which no generator emits any more (handEdits: overwrite)";
    }
}
