package com.metaobjects.mojo;

import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Mojo;

/**
 * {@code metaobjects:docs} — removed in 8.1.0 (ADR-0034 Amendment 9). The goal stays only to
 * say so: a pom that still binds it fails with the line below, where a goal that was simply
 * gone would fail with Maven's "could not find goal", which names neither what replaced it
 * nor where the change is written down.
 *
 * <p>Documentation is generated the way code is: each docs generator is a {@code <generator>}
 * entry in the list {@code metaobjects:generate} runs, with its options in {@code <args>}.</p>
 */
@Mojo(name = "docs", threadSafe = true)
public class DocsMojo extends AbstractMojo {

    /** Where the change to a 1.0 pom is written down, before and after. */
    static final String MIGRATION =
            "docs/features/migrations/docs-are-generators.md, section \"Java and Kotlin\"";

    /** What this goal prints. ADR-0034 Amendment 9 fixes the sentence for every port. */
    static final String REMOVED =
            "metaobjects:docs was removed in 8.1.0. `mvn metaobjects:generate` writes documentation "
                + "now: declare each docs generator as a <generator> entry in the plugin's <generators>. "
                + "See " + MIGRATION + ".";

    @Override
    public void execute() throws MojoFailureException {
        throw new MojoFailureException(REMOVED);
    }
}
