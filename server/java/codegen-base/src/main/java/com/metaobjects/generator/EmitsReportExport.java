package com.metaobjects.generator;

import java.util.Collection;

/**
 * Marker: this generator is a {@code report-export} generator. It emits each served report's
 * {@code <Report>Export} module, which a served report's list route calls to answer
 * {@code ?format=csv|json|xml} (the "Report export" section of
 * {@code docs/features/api-contract.md}).
 *
 * <p>The routes generator grows that {@code format} branch only when the run contains one
 * ({@link RunAware}), so a routes generator never references a module nothing generated, and a
 * wired export generator never emits a module no route calls. This is the JVM side of the rule
 * TypeScript reads from its {@code emitsReportExport} generator marker, C# from its generator
 * list, and Python from {@code ctx.generators}.</p>
 */
public interface EmitsReportExport {

    /** True iff some generator in {@code run} is a {@code report-export} generator. */
    static boolean includedIn(Collection<? extends Generator> run) {
        return run.stream().anyMatch(g -> g instanceof EmitsReportExport);
    }
}
