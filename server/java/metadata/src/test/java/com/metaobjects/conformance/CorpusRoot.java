/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.conformance;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Resolves the single {@code fixtures/conformance/} corpus root once.
 *
 * <p>Java port of the C# {@code CorpusRoot} class. Mirrors the established
 * Java idiom from {@code CanonicalJsonParserTest#resolveCorpusDir} — walk up
 * from the current working directory until a directory containing
 * {@code fixtures/conformance/} is found.</p>
 *
 * <p>Honors the {@code METAOBJECTS_CONFORMANCE_CORPUS} environment variable
 * (mirrors the TS runner's override for mutation-testing sandboxes). When
 * set, the env var must point to an existing directory and is used as the
 * corpus root directly.</p>
 */
public final class CorpusRoot {

    private CorpusRoot() {
        // Utility class — no instantiation.
    }

    /**
     * Locate the corpus root.
     *
     * @return absolute path to {@code fixtures/conformance/}
     * @throws AssertionError if the corpus cannot be found
     */
    public static Path locate() {
        // Environment override — lets mutation-testing sandboxes point at the
        // real corpus via an absolute path.
        String env = System.getenv("METAOBJECTS_CONFORMANCE_CORPUS");
        if (env != null && !env.isEmpty()) {
            Path envPath = Paths.get(env);
            if (!Files.isDirectory(envPath)) {
                throw new AssertionError(
                    "METAOBJECTS_CONFORMANCE_CORPUS points to a non-existent directory: " + env);
            }
            return envPath.toAbsolutePath();
        }

        // Walk up from CWD until we find a directory containing fixtures/conformance/.
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/conformance");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }

        throw new AssertionError(
            "Could not locate fixtures/conformance/ by walking up from: "
                + Paths.get("").toAbsolutePath()
                + ". Set METAOBJECTS_CONFORMANCE_CORPUS to point directly to the corpus.");
    }
}
