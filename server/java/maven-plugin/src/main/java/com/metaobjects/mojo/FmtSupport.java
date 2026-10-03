package com.metaobjects.mojo;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * {@code mvn metaobjects:fmt} (#304) pure logic — no Mojo/Maven type touches
 * this class beyond what its caller already resolved, so it is unit-testable
 * without a real Maven session (mirrors {@link EjectSupport}'s split).
 *
 * <p>Mirrors the TS reference
 * ({@code server/typescript/packages/metadata/src/fmt.ts} +
 * {@code .../cli/src/lib/fmt-engine.ts}) and the C# port exactly:</p>
 * <ul>
 *   <li>Each file is formatted STANDALONE — own-mode, declared-here layer only
 *       (ADR-0039). Never merged with its siblings: {@code extends} onto
 *       another file's base is preserved as the raw ref string (Java's loader
 *       defers forward/cross-file {@code extends} to a post-load resolution
 *       pass this class never runs).</li>
 *   <li>A file declaring {@code overlay: true} ANYWHERE in its tree is
 *       skipped — not only when no base exists in the same file. A formatter
 *       never changes structure: a standalone {@link CanonicalJsonParser} run
 *       (outside a loader batch) drains its own overlay queue immediately,
 *       and when a same-(type,name) base IS present in the same document it
 *       happily MERGES the two, silently dropping the overlay marker from the
 *       output. {@link #hasOverlayDeclaration} checks the raw document for
 *       {@code overlay: true} BEFORE the parser ever runs, so that case is
 *       caught too — {@link ErrorCode#ERR_OVERLAY_NO_TARGET} (the no-local-
 *       target case) is kept only as a defensive second signal.</li>
 *   <li>YAML is always skipped: no canonical YAML emitter exists (ADR-0006).</li>
 *   <li>Before a write lands, the WHOLE project is reloaded with the
 *       candidate substituted in via an {@link InMemoryStringSource} carrying
 *       the real file's id — {@link FileSource} for every other resolved
 *       file — and the write happens ONLY after that reload has no errors AND
 *       its canonical serialization is byte-identical to the untouched
 *       baseline. Nothing is ever written to disk before it is proven safe,
 *       and {@code --check} never writes at all (mirrors TS/C#/Python
 *       exactly; this port no longer writes-then-reverts).</li>
 * </ul>
 */
public final class FmtSupport {

    private FmtSupport() {}

    public enum Status { FORMATTED, WOULD_FORMAT, UNCHANGED, SKIPPED_YAML, SKIPPED_OVERLAY, ERROR }

    public static final class FileReport {
        public final Path path;
        public final Status status;
        public final String detail;

        public FileReport(Path path, Status status, String detail) {
            this.path = path;
            this.status = status;
            this.detail = detail;
        }
    }

    public static final class RunResult {
        public final List<FileReport> files;
        public final String fatal;

        private RunResult(List<FileReport> files, String fatal) {
            this.files = files;
            this.fatal = fatal;
        }

        public static RunResult fatal(String message) { return new RunResult(List.of(), message); }
        public static RunResult ok(List<FileReport> files) { return new RunResult(files, null); }
    }

    public static final class FormatFileResult {
        public final boolean ok;
        public final boolean overlay;
        public final String text;
        public final String message;

        private FormatFileResult(boolean ok, boolean overlay, String text, String message) {
            this.ok = ok;
            this.overlay = overlay;
            this.text = text;
            this.message = message;
        }

        static FormatFileResult success(String text) { return new FormatFileResult(true, false, text, null); }
        static FormatFileResult failure(boolean overlay, String message) { return new FormatFileResult(false, overlay, null, message); }
    }

    /**
     * Format one file's own content. {@code standaloneLoaderFactory} must supply
     * a FRESH, empty-rooted {@link MetaDataLoader} (never one already carrying
     * other files' content), constructed with the LOADER NAME this method
     * passes it — the file's own declared {@code package} (detected via
     * {@link #detectPackage}), or {@code ""} when it declares none.
     *
     * <p>This works around a Java-loader-specific quirk the cross-port
     * conformance harness also works around ({@code ConformanceTest
     * .detectLoaderName}, "mitigates the Java loader-root-name leak"): the
     * canonical serializer emits the LOADER's own name as the root's
     * top-level {@code package} key — the file's {@code "package"} value
     * only sets the default-package CONTEXT children resolve short refs
     * against, and is never itself written back to the root. Naming the
     * standalone loader after the file's own declared package is what makes
     * own-mode round-trip correctly here.</p>
     *
     * <p>Parsing happens directly through {@link CanonicalJsonParser}, outside
     * any loader batch, so its overlay queue drains immediately against
     * whatever this one document alone declares — but only once
     * {@link #hasOverlayDeclaration} has already ruled out an overlay
     * ANYWHERE in the document (see the class doc).</p>
     */
    public static FormatFileResult formatFile(
            Function<String, MetaDataLoader> standaloneLoaderFactory, String content, String sourceId) {
        // Strip a UTF-8 BOM up front — Java-authored files often carry one, and
        // neither Files.readString nor Gson's JsonParser strips it on its own.
        String normalized = stripBom(content);

        if (hasOverlayDeclaration(normalized)) {
            return FormatFileResult.failure(true,
                "this file declares an overlay fmt cannot resolve standalone");
        }

        MetaDataLoader loader = standaloneLoaderFactory.apply(detectPackage(normalized));
        try {
            new CanonicalJsonParser(loader, sourceId)
                .loadFromStream(new ByteArrayInputStream(normalized.getBytes(StandardCharsets.UTF_8)));
        } catch (RuntimeException ex) {
            return FormatFileResult.failure(false, ex.getMessage());
        }

        List<MetaDataException> errors = loader.getErrors();
        if (errors != null && !errors.isEmpty()) {
            boolean overlay = errors.stream().anyMatch(
                e -> e.getCode().map(c -> c == ErrorCode.ERR_OVERLAY_NO_TARGET).orElse(false));
            String message = errors.stream().map(MetaDataException::getMessage)
                .collect(Collectors.joining("; "));
            return FormatFileResult.failure(overlay, message);
        }

        return FormatFileResult.success(CanonicalJsonSerializer.canonicalSerialize(loader.getRoot()));
    }

    /**
     * @param initialBaseline      the project's CURRENT state, already loaded by the
     *                             caller (the Mojo template's own first load) — reused
     *                             rather than reloaded, so a clean project costs exactly
     *                             one load per candidate file, not two.
     * @param allFiles             EVERY file the project's metadata-location ladder
     *                             resolved (not just the ones being formatted) — the
     *                             safety-check reload needs the whole project regardless
     *                             of which files are in {@code targetFiles}
     * @param targetFiles          the files to format, a subset of {@code allFiles}
     * @param librarySources       opted-in MetaObjects-shipped library sources, prepended
     *                             to every reload exactly as a real load would
     * @param freshEmptyLoader     supplies a fresh loader, already {@code .init()}-ed with
     *                             NO sources, sharing the project's registry/strict/name —
     *                             ready for {@link MetaDataLoader#load(List)} to be called
     *                             on it directly. Called once per candidate that needs the
     *                             safety-check reload.
     * @param standaloneLoaderFactory supplies a fresh, empty-rooted loader given the LOADER
     *                             NAME to construct it with (see {@link #formatFile}) — never
     *                             the file's own source id, which may contain characters
     *                             (dots) a loader name may not
     * @param check                never writes, under any circumstance — the safety check
     *                             still runs so --check and a real run share one decision
     */
    public static RunResult run(
            MetaDataLoader initialBaseline,
            List<Path> allFiles,
            List<Path> targetFiles,
            List<MetaDataSource> librarySources,
            Supplier<MetaDataLoader> freshEmptyLoader,
            Function<String, MetaDataLoader> standaloneLoaderFactory,
            boolean check) {

        List<MetaDataException> baselineErrors = initialBaseline.getErrors();
        if (baselineErrors != null && !baselineErrors.isEmpty()) {
            String msg = baselineErrors.stream().map(MetaDataException::getMessage)
                .collect(Collectors.joining("\n  "));
            return RunResult.fatal(
                "this project's metadata does not currently load cleanly — fix the error(s) below, "
                    + "then re-run fmt:\n  " + msg);
        }
        String baselineCanonical = CanonicalJsonSerializer.canonicalSerialize(initialBaseline.getRoot());

        List<FileReport> reports = new ArrayList<>();
        for (Path path : targetFiles) {
            String name = path.getFileName().toString();
            String ext = extensionOf(name);
            if (ext.equals("yaml") || ext.equals("yml")) {
                reports.add(new FileReport(path, Status.SKIPPED_YAML,
                    "no canonical YAML emitter exists (ADR-0006: JSON is the canonical interchange form) — left untouched"));
                continue;
            }

            String content = readString(path);
            FormatFileResult formatted = formatFile(standaloneLoaderFactory, content, name);
            if (!formatted.ok) {
                reports.add(new FileReport(path,
                    formatted.overlay ? Status.SKIPPED_OVERLAY : Status.ERROR, formatted.message));
                continue;
            }

            if (formatted.text.equals(content)) {
                reports.add(new FileReport(path, Status.UNCHANGED, null));
                continue;
            }

            // Safety check: reload the WHOLE project with the candidate substituted
            // in via an in-memory source — nothing on disk changes yet. Only once
            // that reload is proven clean AND canonically byte-identical to the
            // baseline does a (non-check) run write the real file. A file is never
            // written before it is verified, and --check never writes at all.
            MetaDataLoader test = freshEmptyLoader.get();
            test.load(buildSources(allFiles, librarySources, path, formatted.text));
            List<MetaDataException> testErrors = test.getErrors();
            boolean safe = (testErrors == null || testErrors.isEmpty())
                && CanonicalJsonSerializer.canonicalSerialize(test.getRoot()).equals(baselineCanonical);

            if (!safe) {
                reports.add(new FileReport(path, Status.ERROR,
                    "formatting this file would change the loaded model's meaning — left unchanged"));
            } else if (check) {
                reports.add(new FileReport(path, Status.WOULD_FORMAT, null));
            } else {
                writeString(path, formatted.text);
                reports.add(new FileReport(path, Status.FORMATTED, null));
            }
        }

        return RunResult.ok(reports);
    }

    /**
     * Build the source list for one project reload: {@code librarySources} first
     * (matching a real load's order), then every file in {@code allFiles} as a
     * {@link FileSource} — except {@code overridePath}, which loads from
     * {@code overrideText} via an {@link InMemoryStringSource} carrying the same
     * id a {@link FileSource} for that path would have used. Disk is never
     * touched for {@code overridePath}.
     */
    private static List<MetaDataSource> buildSources(
            List<Path> allFiles, List<MetaDataSource> librarySources, Path overridePath, String overrideText) {
        List<MetaDataSource> sources = new ArrayList<>(librarySources);
        for (Path p : allFiles) {
            if (overridePath != null && p.equals(overridePath)) {
                sources.add(new InMemoryStringSource(overrideText, p.getFileName().toString()));
            } else {
                sources.add(new FileSource(p));
            }
        }
        return sources;
    }

    /**
     * Whether {@code content}'s canonical-JSON shape declares an
     * {@code overlay: true} node anywhere in its tree — the top-level
     * declaration itself, or any descendant reached by walking {@code
     * children} arrays. A purely STRUCTURAL check (independent of the
     * registry), run before the document is ever parsed into a tree — see the
     * class doc for why a same-file base+overlay merge must never happen in
     * the first place. Malformed or non-JSON content answers {@code false};
     * {@link #formatFile}'s own parse reports that failure properly.
     */
    static boolean hasOverlayDeclaration(String content) {
        try {
            JsonElement el = JsonParser.parseString(content);
            if (!el.isJsonObject()) return false;
            JsonObject top = el.getAsJsonObject();
            for (String key : top.keySet()) {
                if ("$schema".equals(key)) continue;
                JsonElement body = top.get(key);
                if (body == null || !body.isJsonObject()) continue;
                return bodyHasOverlay(body.getAsJsonObject());
            }
            return false;
        } catch (Exception ignore) {
            return false;
        }
    }

    private static boolean bodyHasOverlay(JsonObject body) {
        JsonElement childrenEl = body.get("children");
        if (childrenEl == null || !childrenEl.isJsonArray()) return false;
        for (JsonElement child : childrenEl.getAsJsonArray()) {
            if (!child.isJsonObject()) continue;
            for (String key : child.getAsJsonObject().keySet()) {
                JsonElement childBodyEl = child.getAsJsonObject().get(key);
                if (childBodyEl == null || !childBodyEl.isJsonObject()) continue;
                JsonObject childBody = childBodyEl.getAsJsonObject();
                JsonElement overlayEl = childBody.get("overlay");
                if (overlayEl != null && overlayEl.isJsonPrimitive()
                        && overlayEl.getAsJsonPrimitive().isBoolean() && overlayEl.getAsBoolean()) {
                    return true;
                }
                if (bodyHasOverlay(childBody)) return true;
            }
        }
        return false;
    }

    /**
     * Pre-scan a file's raw content for its declared {@code metadata.root.package}.
     * Empty string when absent, malformed, or not JSON — a YAML file never
     * reaches this (callers skip YAML before calling {@link #formatFile}), and
     * any other failure here just means the standalone loader gets named ""
     * (itself harmless: {@link #formatFile}'s OWN parse of the same content
     * is what actually reports the real error). Mirrors {@code ConformanceTest
     * .detectLoaderName} exactly — same workaround, same reason.
     */
    static String detectPackage(String content) {
        try {
            JsonElement el = JsonParser.parseString(content);
            if (!el.isJsonObject()) return "";
            JsonObject root = el.getAsJsonObject();
            JsonElement metaRootEl = root.get("metadata.root");
            if (metaRootEl == null || !metaRootEl.isJsonObject()) return "";
            JsonElement pkgEl = metaRootEl.getAsJsonObject().get("package");
            if (pkgEl != null && pkgEl.isJsonPrimitive() && pkgEl.getAsJsonPrimitive().isString()) {
                return pkgEl.getAsString();
            }
            return "";
        } catch (Exception ignore) {
            return "";
        }
    }

    /** Strips a leading UTF-8 BOM character, if present. */
    private static String stripBom(String content) {
        return !content.isEmpty() && content.charAt(0) == '﻿' ? content.substring(1) : content;
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase();
    }

    private static String readString(Path path) {
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static void writeString(Path path, String content) {
        try {
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
