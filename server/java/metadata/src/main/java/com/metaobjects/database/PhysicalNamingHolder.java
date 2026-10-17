package com.metaobjects.database;

/**
 * A metadata node that carries its own project physical-naming rules (ADR-0058), rather
 * than inheriting them by walking to an ancestor.
 *
 * <p>{@link com.metaobjects.MetaRoot} is the ordinary case: every attached node resolves
 * its rules by walking up to the root. A node detached from the loaded tree — one built
 * fresh and never attached as a child of any root — has no such ancestor to walk to, so it
 * implements this interface itself, holding a copy captured at build time from whatever
 * root it WAS built from. {@code ReportReadModel} (a report's detached read model) is the
 * one case in this codebase; see its class doc.</p>
 *
 * @see PhysicalNaming#of(com.metaobjects.MetaData)
 */
public interface PhysicalNamingHolder {

    /** This node's physical-naming rules. Never {@code null}. */
    PhysicalNaming getPhysicalNaming();
}
