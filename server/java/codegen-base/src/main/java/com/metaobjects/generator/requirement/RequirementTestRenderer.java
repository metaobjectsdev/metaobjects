package com.metaobjects.generator.requirement;

/**
 * Replaces the default rendering of a requirement's test (ADR-0057). Name an implementation in
 * the {@code renderer} arg of the {@code requirement-tests} generator: a public class with a
 * public no-argument constructor, found on the project's classpath. The generators for the
 * JVM languages share this type: a renderer returns source in the language of the generator that
 * calls it, so a project that runs both writes one renderer for each.
 *
 * <p>The identity of a test, which tests exist and what each is called, is not the renderer's to
 * change: it receives them in {@link RequirementTestArgs}. An application that wants different
 * identities owns the generator itself ({@code mvn metaobjects:eject}).</p>
 */
public interface RequirementTestRenderer {

    /**
     * @return the rendered test, or {@code null} to keep the default rendering of this one test
     */
    RenderedTest render(RequirementTestArgs args);
}
