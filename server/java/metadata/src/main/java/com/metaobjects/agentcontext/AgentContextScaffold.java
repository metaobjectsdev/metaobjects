package com.metaobjects.agentcontext;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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

    private AgentContextScaffold() {
    }

    /** A file to (over)write at its own path. */
    public record Write(String path, String contents) {
    }

    /** A hand-edited file: write the fresh contents to {@code newPath}, keep the original. */
    public record Conflict(String path, String newPath, String contents) {
    }

    /** Tracks what the assembler last wrote, so re-runs can detect hand-edits. */
    public record Manifest(int version, List<String> servers, List<String> clients,
                           Map<String, String> files) {
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
     * @return the scaffold decision (writes, conflicts, manifest, removed).
     */
    public static ScaffoldDecision plan(Stack stack, List<AssembledFile> assembled,
                                        Manifest prior,
                                        Function<String, String> readCurrent) {
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
                List.copyOf(stack.servers()),
                List.copyOf(stack.clients()),
                files);
        return new ScaffoldDecision(writes, conflicts, manifest, removed);
    }
}
