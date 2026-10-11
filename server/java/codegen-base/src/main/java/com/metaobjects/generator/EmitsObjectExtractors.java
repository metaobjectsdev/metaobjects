package com.metaobjects.generator;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * Marker: this generator EMITS the per-object {@code <Name>Extractor} classes, as a
 * generator of its own in the run.
 *
 * <p>The Java {@code entity} generator has always written those classes itself, beside each
 * concrete flavored class, and still does when nothing else in the run will. The marker
 * exists so a RUN can answer the question {@code entity} cannot answer alone: <em>is a
 * separate extractor generator writing these files?</em> When one is, {@code entity} leaves
 * them to it. Without that, wiring an owned extractor next to {@code entity} put two
 * emitters on one path: identical output hid the duplicate, and the first edit to the owned
 * copy failed the build as an output path collision.</p>
 *
 * <p>Same shape as {@link EmitsPhysicalNameConstants}: the Maven mojo builds the whole
 * {@link Generator} list before it runs any of it, so that is where the answer is derived,
 * and an explicit value in the pom always wins.</p>
 */
public interface EmitsObjectExtractors {

    /**
     * The {@code entity} generator arg that says whether it writes the
     * {@code <Name>Extractor} classes itself. Defaults to {@code true}, which is what it
     * did before the extractor could be wired separately.
     */
    String ARG_EMIT_EXTRACTORS = "emitExtractors";

    /** True iff some generator in {@code generators} emits the extractors on its own. */
    static boolean includesExtractors(Collection<? extends Generator> generators) {
        return generators.stream().anyMatch(g -> g instanceof EmitsObjectExtractors);
    }

    /**
     * {@code args} with {@link #ARG_EMIT_EXTRACTORS} derived from the run's generator set.
     *
     * <p>An explicit value in {@code args} wins. Absent, it becomes {@code "false"} exactly
     * when a separate extractor generator is in the run, and is left unset otherwise, so a
     * run without one behaves as it always has.</p>
     */
    static Map<String, String> deriveEmitExtractors(Map<String, String> args,
                                                    Collection<? extends Generator> generators) {
        if (args.containsKey(ARG_EMIT_EXTRACTORS) || !includesExtractors(generators)) return args;
        Map<String, String> derived = new HashMap<>(args);
        derived.put(ARG_EMIT_EXTRACTORS, "false");
        return derived;
    }
}
