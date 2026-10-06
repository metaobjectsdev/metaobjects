package com.metaobjects.generator;

/**
 * Implemented by a generator that must load a class the PROJECT names in one of its args (a
 * renderer or a filter, say). The Maven plugin hands such a generator the project's class
 * loader right after constructing it.
 *
 * <p>It exists because a packaged generator is found through the plugin's own class loader,
 * which cannot see the project's classes: the project loader is a child that delegates to its
 * parent first, so a generator that loads a named class through its own loader never finds one
 * that lives only in the project. A generator that needs no project class does not implement
 * this, and every generator is still constructed the same way.</p>
 */
public interface ProjectClassLoaderAware {

    /** The loader that sees the project's compile and test classpath. Never {@code null}. */
    void setProjectClassLoader(ClassLoader projectClassLoader);
}
