package com.metaobjects.generator;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * Marker: this generator EMITS the per-object physical-name constants artifact
 * ({@code <Entity>Names}) — the one place a table/column name is spelled, so every other
 * generator can reference it instead of respelling it ("NO MAGIC STRINGS").
 *
 * <p>The marker exists so a RUN can answer one question the individual generators cannot:
 * <em>will the names artifact exist alongside my output?</em> A generator that emits
 * {@code AuthorNames.NAME} into a run with no names generator produces code referencing a
 * type nothing generated — it does not compile. That risk is why the JVM ports' constant
 * substitution shipped behind an opt-in arg defaulting OFF, with a comment stating the JVM
 * has "no runner aggregating markers". It does: the Maven mojo builds the whole
 * {@link Generator} list before executing any of it, which is exactly the aggregation
 * point. This interface plus {@link #deriveUseNames} is that aggregation, and it makes the
 * three ports agree — TypeScript's {@code emitsNames} generator marker feeding
 * {@code ResolvedGenConfig.includeNames}, C#'s {@code GeneratorRegistry.IncludesNames},
 * and this.</p>
 *
 * <p>It is a PRESENCE guard, never a divergence/equality guard: it answers "is the artifact
 * in this run", not "does the artifact agree with what I would have derived". A physical
 * name two resolvers disagree about is a build error owned by
 * {@code com.metaobjects.source.SourceResolution}, not something to paper over by falling
 * back to a literal.</p>
 */
public interface EmitsPhysicalNameConstants {

    /**
     * The generator arg every JVM generator reads to decide whether {@code <Entity>Names}
     * will exist in this run. Set on EVERY generator of a run that contains at least one
     * {@code EmitsPhysicalNameConstants}, unless the project set it explicitly.
     */
    String ARG_USE_NAMES = "useNames";

    /** True iff some generator in {@code generators} emits the names artifact. */
    static boolean includesNames(Collection<? extends Generator> generators) {
        return generators.stream().anyMatch(g -> g instanceof EmitsPhysicalNameConstants);
    }

    /**
     * {@code args} with {@link #ARG_USE_NAMES} derived from the run's generator set.
     *
     * <p>An EXPLICIT value in {@code args} always wins — a project that has deliberately
     * pinned the flag (to keep a golden byte-identical, say) is not overridden by a
     * derivation. Absent, it becomes {@code "true"} exactly when the names generator is in
     * the run, so the common case — a full suite — needs no configuration at all, and a
     * narrowed suite that drops {@code names} silently goes back to literals rather than
     * emitting code that will not compile.</p>
     */
    static Map<String, String> deriveUseNames(Map<String, String> args,
                                              Collection<? extends Generator> generators) {
        if (args.containsKey(ARG_USE_NAMES)) return args;
        Map<String, String> derived = new HashMap<>(args);
        derived.put(ARG_USE_NAMES, Boolean.toString(includesNames(generators)));
        return derived;
    }
}
