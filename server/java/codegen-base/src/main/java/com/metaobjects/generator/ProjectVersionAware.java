package com.metaobjects.generator;

/**
 * Implemented by a generator that publishes the version of the project it runs in (the shared
 * model's manifest records it). The Maven plugin hands such a generator {@code ${project.version}}
 * right after constructing it, so a pom need not repeat the version in an arg.
 *
 * <p>A generator that needs no project version does not implement this. An explicit arg a
 * generator reads still wins; this is only the default.</p>
 */
public interface ProjectVersionAware {

    /** The running project's version, as Maven reports it. Never {@code null}. */
    void setProjectVersion(String projectVersion);
}
