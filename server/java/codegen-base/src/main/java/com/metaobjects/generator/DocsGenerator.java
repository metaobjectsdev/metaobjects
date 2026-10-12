package com.metaobjects.generator;

/**
 * A generator that writes documentation, not code: the api reference {@code
 * mvn metaobjects:docs} produces.
 *
 * <p>{@code metaobjects:generate} writes code under {@code outputDir}, and its drift check,
 * {@code metaobjects:verify}, regenerates code and diffs it against the committed tree. A docs
 * generator does neither: its pages land under the docs output directory, relative to it, and
 * are not code the build compiles. A generator that takes part in the docs run says so by
 * implementing this interface. {@code generate} and {@code verify} skip it and say so, and
 * {@code docs} runs it.</p>
 *
 * <p>One {@code <generators>} list serves all three goals. An owned {@code api-docs} copy is
 * listed beside the code generators, and each goal runs the half that is its own. When the list
 * holds a docs generator for a surface, {@code docs} runs it in place of the packaged one.</p>
 *
 * <p>The goal sets these args on the generator: {@link #ARG_PROJECT_NAME}, {@link
 * #ARG_API_SUBDIR}, {@link #ARG_LAYOUT} and {@link #ARG_MODEL_BASE_URL}, plus {@code outputDir},
 * the docs output directory.</p>
 */
public interface DocsGenerator extends Generator {

    /** The label the agent page carries in its header. */
    String ARG_PROJECT_NAME = "projectName";

    /** Where under {@code outputDir} the api reference lands, e.g. {@code api/java}. */
    String ARG_API_SUBDIR = "apiSubDir";

    /** The page layout: {@code flat} (one file per unit, the default) or {@code package}. */
    String ARG_LAYOUT = "layout";

    /** When set, the base URL the model pages' back-links federate to. */
    String ARG_MODEL_BASE_URL = "modelBaseUrl";

    /** The surface this generator documents: {@code java} or {@code kotlin}. {@code docs} hands
     *  the surface to the docs generator in the project's list that names it. */
    String surface();
}
