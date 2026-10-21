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
import java.util.function.Supplier;
import java.util.stream.Collectors;

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
 *   <li>On the JVM every entry names its {@link HashManifest.Owner}, the generator and
 *       output directory that emitted it ({@link #isCandidate}). An entry is this run's
 *       to judge when this run's own generators own it, or when what owns it is configured
 *       in no {@code metaobjects:generate} execution of the module (a removed generator,
 *       or an entry with no owner in one of this run's output directories). An entry
 *       another configured generator owns is that generator's, even in a shared output
 *       directory.</li>
 *   <li>A file is judged once, by the innermost swept directory that holds it, so a
 *       directory nested in another is judged by its own generators' policy; a file in
 *       none of them is judged as {@code keep}.</li>
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
     * Whether the sweep may judge an entry owned by {@code owner} ({@code null}: recorded
     * with no owner): {@code runOwners} own it, or {@code configured} (every
     * generator/output-directory pair configured in the module; {@code null} when that is
     * unknown) does not hold it. An entry with no owner counts only inside one of this
     * run's output directories ({@code inRunDir}), since outside them it may be another
     * port's. {@code configured} is asked only when the answer depends on it.
     */
    public static boolean isCandidate(HashManifest.Owner owner, boolean inRunDir,
                                      Set<HashManifest.Owner> runOwners, Supplier<Set<HashManifest.Owner>> configured) {
        if (owner != null && runOwners.contains(owner)) return true;
        if (owner == null && !inRunDir) return false;
        Set<HashManifest.Owner> known = configured.get();
        return known != null && (owner == null || !known.contains(owner));
    }

    /**
     * Delete the untouched recorded files no generator of this run emitted ({@code emitted}:
     * normalized absolute paths this run produced, refused hand-edits included) that the
     * run may judge ({@link #isCandidate}), and forget every such entry whose file is
     * already gone. No-op (empty result, manifest untouched) when the project has no
     * manifest yet — there is nothing recorded, so nothing could be an orphan.
     */
    public static Result sweep(Path genStateDir, Path projectRoot, List<Entry> dirs, Set<Path> emitted,
                               Set<HashManifest.Owner> runOwners, Supplier<Set<HashManifest.Owner>> configured) {
        if (!HashManifest.exists(genStateDir)) {
            return new Result(List.of(), List.of(), List.of());
        }
        Map<String, String> hashes = HashManifest.load(genStateDir);
        Map<String, HashManifest.Owner> owners = HashManifest.loadOwners(genStateDir);
        Set<String> forget = new LinkedHashSet<>();
        List<String> removed = new ArrayList<>();
        List<String> overwrittenDeleted = new ArrayList<>();
        List<String> refused = new ArrayList<>();
        Path root = projectRoot.toAbsolutePath().normalize();

        Map<Path, Entry> byDir = new LinkedHashMap<>();
        for (Entry e : dirs) {
            byDir.putIfAbsent(e.dir.toAbsolutePath().normalize(), e);
        }

        for (String key : hashes.keySet()) {
            Path path = root.resolve(key).normalize();
            if (!path.startsWith(root) || emitted.contains(path)) continue;
            Path dir = innermost(byDir.keySet(), path);
            if (!isCandidate(owners.get(key), dir != null, runOwners, configured)) continue;
            if (!Files.exists(path)) {
                // Already gone: forget it, so a stranger's file created later under that
                // name is not mistaken for ours.
                forget.add(key);
                continue;
            }
            if (!Files.isRegularFile(path)) continue;

            Entry e = dir != null ? byDir.get(dir) : null;
            String shown = e != null
                    ? e.label + dir.relativize(path).toString().replace(java.io.File.separatorChar, '/')
                    : key;
            switch (classify(hashes, root, path)) {
                case PRISTINE:
                    delete(path);
                    forget.add(key);
                    removed.add(shown);
                    break;
                case EDITED:
                    if (e != null && e.allowOverwrite) {
                        delete(path);
                        forget.add(key);
                        overwrittenDeleted.add(shown);
                    } else {
                        refused.add(key);
                    }
                    break;
                case STRANGER:
                default:
                    break;
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

    /** The deepest of {@code dirs} holding {@code path}, or {@code null}. */
    public static Path innermost(Iterable<Path> dirs, Path path) {
        Path best = null;
        for (Path d : dirs) {
            if (path.startsWith(d) && (best == null || d.getNameCount() > best.getNameCount())) best = d;
        }
        return best;
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
