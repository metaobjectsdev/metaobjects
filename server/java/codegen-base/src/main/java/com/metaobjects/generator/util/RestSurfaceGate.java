package com.metaobjects.generator.util;

import com.metaobjects.MetaData;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import com.metaobjects.source.RdbSource;

/**
 * THE predicate deciding which objects get a generated REST surface, shared by every
 * JVM generator that emits one.
 *
 * <p>A "REST surface" is a TRIO — the controller, the consumer-seam repository
 * interface it delegates to, and the filter allowlist its list handler reads. The three
 * must pick the same objects or the emitted tree does not compile: the controller NAMES
 * the other two. That is not a style preference, it is the failure mode — Java's three
 * generators each carried a verbatim copy of this predicate, and Kotlin carried a fifth.
 * Widening one and forgetting another produces an emitted controller importing an
 * allowlist nothing generated, and {@code generate} still exits 0.</p>
 *
 * <p><b>Two shapes qualify.</b> A WRITABLE object ({@code object.entity} over a
 * {@code @kind: table} source, or a write-through entity owning both a table and a
 * replica view) gets the full CRUD surface. A READ-ONLY {@code object.projection} over a
 * view / materializedView source gets a read-only surface — reads served, every write
 * verb answering {@code 405 {"error": "method_not_allowed"}} (F22). Everything else —
 * abstract objects, {@code object.value}, sourceless projections, and the proc /
 * table-function kinds that have no controller story on the JVM — gets nothing.</p>
 *
 * <p>Lives beside {@link RouteNaming} and for the same reason: two hand-maintained
 * copies of a rule, with nothing tying them together, is exactly what let that one go
 * stale across the JVM ports.</p>
 */
public final class RestSurfaceGate {

    private RestSurfaceGate() { /* no instances */ }

    /**
     * First {@link RdbSource} child of {@code obj}, or {@code null} when absent.
     * OWN children, and ORDER-DEPENDENT — which is why the write-through arm of
     * {@link #emitsRestSurface(MetaObject)} asks {@link MetaObject#isWriteThrough()}
     * rather than reading this source's kind (a write-through object may declare its
     * replica view first).
     */
    public static RdbSource firstRdbSource(MetaObject obj) {
        for (MetaData child : obj.getChildren()) {
            if (child instanceof RdbSource) return (RdbSource) child;
        }
        return null;
    }

    /**
     * True iff the controller / repository / filter-allowlist trio emits for {@code obj}.
     * Use {@link #isReadOnly(MetaObject)} to choose WHICH surface to emit.
     */
    public static boolean emitsRestSurface(MetaObject obj) {
        if (GeneratorUtil.isAbstract(obj)) return false;
        if (isWritable(obj)) return true;
        return isReadOnly(obj);
    }

    /**
     * True iff {@code obj} gets the WRITABLE (full CRUD) surface: a concrete
     * {@code object.entity} whose first {@code source.rdb} is {@code @kind: table}, or a
     * write-through entity (owning both a writable table and a read-only replica view,
     * in either declaration order).
     *
     * <p>Extracted verbatim from the three generators' former copies — the semantics
     * here are unchanged, so no object that used to get a controller stops getting one.</p>
     */
    public static boolean isWritable(MetaObject obj) {
        if (!MetaObject.SUBTYPE_ENTITY.equals(obj.getSubType())) return false;
        if (GeneratorUtil.isAbstract(obj)) return false;
        RdbSource sourceRdb = firstRdbSource(obj);
        if (sourceRdb == null) return false;
        return obj.isWriteThrough() || MetaSource.KIND_TABLE.equals(sourceRdb.getEffectiveKind());
    }

    /**
     * True iff {@code obj} gets the READ-ONLY surface (F22): a concrete
     * {@code object.projection} whose sources are ALL view / materializedView.
     *
     * <p>Restricted to those two kinds rather than to {@link MetaSource#isReadOnly()},
     * which also covers {@code storedProc} and {@code tableFunction}. Those have no
     * controller story on the JVM — a proc is invoked, not listed and filtered — and
     * admitting them here would mount a REST collection over something no repository
     * method can page.</p>
     *
     * <p>A write-through entity is NOT read-only: it owns a writable table too, and
     * {@link #isWritable(MetaObject)} has already claimed it. A SOURCELESS projection
     * (#248) has no backing store, generates nothing and is excluded by the
     * "at least one view source" requirement.</p>
     */
    public static boolean isReadOnly(MetaObject obj) {
        if (!MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) return false;
        if (GeneratorUtil.isAbstract(obj)) return false;
        boolean anyView = false;
        // ADR-0039: RESOLVING (includeParentData=true) — a projection that inherits its
        // source through `extends` is backed by exactly the same store as one declaring it.
        for (MetaSource src : obj.getSources(true)) {
            String kind = src.getEffectiveKind();
            if (MetaSource.KIND_VIEW.equals(kind) || MetaSource.KIND_MATERIALIZED_VIEW.equals(kind)) {
                anyView = true;
            } else {
                return false;
            }
        }
        return anyView;
    }

    /**
     * True iff {@code obj} is addressable by a single-column primary key, i.e. its REST
     * surface carries the {@code /{id}} item routes at all.
     *
     * <p>Only the read-only surface asks: a projection's identity is OPTIONAL
     * (ADR-0028), and a keyless one mounts no item GET — so it must refuse no item
     * write either, or it would advertise an address the port never serves. The writable
     * surface has always emitted item routes unconditionally and is untouched.</p>
     */
    public static boolean hasItemRoute(MetaObject obj) {
        // ADR-0039: resolving — a projection's `identity.primary` typically EXTENDS the
        // base entity's, and an own-only read would miss an inherited one entirely.
        for (MetaIdentity identity : obj.getIdentities(true)) {
            if (identity.isPrimary()) return identity.getFields().size() == 1;
        }
        return false;
    }
}
