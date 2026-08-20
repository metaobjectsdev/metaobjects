/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.config;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.FileSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Turns a declared source SET ({@code .metaobjects/config.json}'s {@code sources}, or
 * the single-entry default when it is absent/empty) into a de-duplicated list of
 * metadata file paths.
 *
 * <p>Behavioral contract: {@code server/typescript/packages/sdk/src/sources.ts} +
 * {@code collection.ts} (the cross-port authority). File ORDER is deliberately NOT a
 * cross-port contract (each port keeps its own natural order — this port's is a
 * basename sort within a directory) — only the resolved SET and the error behavior
 * are gated by the shared corpus at
 * {@code fixtures/source-resolution-conformance/cases.json}.
 */
public final class SourceResolver {

    private SourceResolver() {}

    /**
     * Resolve a declared source SET to a de-duplicated list of metadata files.
     *
     * <p>A relative {@code path} resolves against {@code configDir} — the directory
     * HOLDING the {@code .metaobjects/} folder — never against the process working
     * directory.
     *
     * <p>Validation runs in two passes: EVERY spec's kind is checked first, in
     * declared order, before any spec is resolved against the filesystem.
     * Interleaving the two (validate-then-resolve spec by spec) would make which
     * error fires depend on which unsupported spec or missing path happens to sit
     * first — the corpus pins that an unsupported KIND anywhere in the list wins over
     * an unresolved PATH regardless of which is declared first
     * ({@code unsupported-kind-precedes-unresolved-path-when-path-is-declared-first}/
     * {@code -second}).
     *
     * <p>Pass 2 processes the validated specs in CONTENT order (natural string
     * ordering of each spec's {@code path}), not declared order — mirroring the
     * reference implementation's {@code orderedPathSpecs}
     * ({@code sources.ts}: kind-validated, then sorted by
     * {@code JSON.stringify(spec)}, which for a validated {@code path}-only spec
     * reduces to sorting by the path string alone). This does not change the
     * resolved file SET — de-duplication is order-independent — only which
     * declared path's {@code ERR_SOURCE_UNRESOLVED} fires first when more than one
     * is simultaneously unresolvable, which order-independence alone cannot pin.
     */
    public static List<Path> resolveSources(Path configDir, List<Map<String, String>> specs) {
        // Pass 1 — kind validation across the WHOLE set, no filesystem I/O yet.
        List<String> pathSpecs = new ArrayList<>(specs.size());
        for (Map<String, String> spec : specs) {
            String rawPath = spec.get("path");
            if (rawPath == null) {
                String kind = spec.keySet().stream().findFirst().orElse("<empty>");
                throw new MetaDataException(
                        "source kind \"" + kind + "\" is not supported by this toolchain yet; use a \"path\" source",
                        ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED);
            }
            pathSpecs.add(rawPath);
        }
        Collections.sort(pathSpecs);

        // Pass 2 — resolve each validated path spec against the filesystem.
        LinkedHashSet<Path> seen = new LinkedHashSet<>();
        for (String rawPath : pathSpecs) {
            Path raw = Path.of(rawPath);
            Path target = raw.isAbsolute() ? raw : configDir.resolve(raw).normalize();

            boolean isDir = Files.isDirectory(target);
            if (!isDir && !Files.isRegularFile(target)) {
                throw new MetaDataException(
                        "source path \"" + rawPath + "\" does not exist (resolved to " + target
                                + ", relative to " + configDir + ")",
                        ErrorCode.ERR_SOURCE_UNRESOLVED);
            }

            if (isDir) {
                // Directory expansion — extension filter and basename sort (this
                // port's own order, deliberately NOT a cross-port contract — see the
                // class javadoc) — is DirectorySource's, the SAME code the loader
                // itself uses to turn a directory into metadata files. Reimplementing
                // the walk here would be a second, driftable definition of "which
                // files count as metadata". `_pending/`-at-any-depth exclusion is OFF
                // by default at the loader level (a runtime app embedding
                // DirectorySource directly gets every file) — this CLI-facing
                // resolver turns it ON, since `_pending/` is the TypeScript CLI's
                // pending/promote-workflow concept, not a loader concept.
                // try-with-resources: expand() wraps Files.walk(), which the JDK
                // documents as requiring prompt closing of its underlying
                // directory-handle resource ("must be used within a try-with-resources
                // statement or similar control structure") — a plain `.forEach()`
                // with no `close()` leaks it on every directory source resolved.
                try (Stream<FileSource> stream =
                        new DirectorySource(target, new DirectorySource.Options().setExcludePending(true)).expand()) {
                    stream.forEach(fs -> seen.add(fs.getPath().toAbsolutePath().normalize()));
                }
            } else {
                seen.add(target.toAbsolutePath().normalize());
            }
        }

        return new ArrayList<>(seen);
    }

    /**
     * The full ladder: declared {@code sources}, else the default directory. Only the
     * DEFAULT may be silently absent — a declared source that does not resolve is
     * {@code ERR_SOURCE_UNRESOLVED}, a louder failure than "nothing declared".
     */
    public static List<Path> resolveCollection(Path root) {
        Path base = root.toAbsolutePath().normalize();
        List<Map<String, String>> specs = NeutralConfig.read(base)
                .map(NeutralConfig::getSources)
                .orElse(List.of());

        if (specs.isEmpty()) {
            Path defaultDir = base.resolve(NeutralConfig.DEFAULT_METADATA_DIR);
            if (!Files.isDirectory(defaultDir)) {
                throw new MetaDataException(
                        "no metadata sources declared in " + base + " and no default \""
                                + NeutralConfig.DEFAULT_METADATA_DIR + "\" directory found. Declare \"sources\" in "
                                + ".metaobjects/config.json, or run 'meta init' to scaffold.",
                        ErrorCode.ERR_COLLECTION_NOT_FOUND);
            }
            specs = List.of(Map.of("path", NeutralConfig.DEFAULT_METADATA_DIR));
        }

        return resolveSources(base, specs);
    }
}
