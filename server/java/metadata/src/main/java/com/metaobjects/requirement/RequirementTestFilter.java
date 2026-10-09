package com.metaobjects.requirement;

/**
 * Which requirements get a generated test: a predicate over the requirement view (ADR-0057).
 * The same seam in every port; a project replaces the default (functional, level 4 or above)
 * by naming an implementation in the {@code filter} arg of the {@code requirement-tests}
 * generator.
 *
 * <p>It lives beside {@link RequirementTestIdentities} because the identity function applies
 * it. The view never hands out the node: it is a projection, so an application's policy does
 * not bind to metamodel internals.</p>
 */
public interface RequirementTestFilter {

    /** Whether the requirement this view describes gets a test. A filter REPLACES the default. */
    boolean include(RequirementTestIdentities.View view);
}
