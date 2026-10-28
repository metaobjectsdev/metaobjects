package com.metaobjects.generator;

import java.util.Collection;

/**
 * Implemented by a generator whose output depends on which other generators are in the same
 * run. The Maven plugin builds the whole configured {@link Generator} list before it executes
 * any of it, and hands that list to every {@code RunAware} generator in it, itself included.
 *
 * <p>A generator that needs no sibling does not implement this. One that does reads the run
 * through a marker interface such as {@link EmitsReportExport}, never a class name, so an
 * owned (ejected) copy of the sibling counts the same as the packaged one.</p>
 */
public interface RunAware {

    /** Every generator configured for this run, in declaration order. Never {@code null}. */
    void setRun(Collection<? extends Generator> run);
}
