package com.metaobjects.source;

import com.metaobjects.MetaDataException;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * THE {@code @role: primary} source lookup for the JVM ports — and the one place the
 * primary-source DIVERGENCE refusal lives, so that every caller inherits it.
 *
 * <p>It lives in the {@code metadata} module, not under a codegen module, because the
 * RUNTIME calls it too: {@link MetaObject#findPrimaryWritableSource()} feeds
 * {@code getPrimaryRdbTableName()}, which is how OMDB
 * ({@code SimpleMappingHandlerDB.getTableRef}) decides which physical table to read and
 * write. Under a codegen module the runtime would have to either invert its layering to
 * reach it or keep its own copy — and its own copy is exactly the shape this class exists
 * to forbid. Mirrors Python's {@code metaobjects.source_resolution}, whose codegen,
 * api-docs and runtime callers all inherit the refusal for free.</p>
 *
 * <h2>The refusal</h2>
 *
 * <p>An object whose {@code @role: primary} sources resolve to MORE THAN ONE physical
 * name has no single answer to give, so {@link #refuseDivergentPrimaries} throws rather
 * than picking one. The shape loads with ZERO errors: {@code ValidateOnePrimarySource}
 * enforces "exactly one primary" over OWN children only, and effective-children shadowing
 * matches an own child over a super child only on a {@code (type, name)} pair — so two
 * {@code source.rdb} nodes with DIFFERENT explicit names at two levels of an
 * {@code extends} chain never collide, and both survive the resolving source walk.</p>
 *
 * <p>Every consumer downstream binds ONE name unconditionally, with no per-site equality
 * guard. The refusal used to live in each codegen module's own {@code resolveObjectNames}
 * — which runs only when the {@code names} generator is in the run — so a
 * {@code mvn metaobjects:generate} without it, and every OMDB read and write, silently
 * bound the PARENT's table while the child declared its own. A refusal that depends on
 * which consumer asked is not a refusal.</p>
 *
 * <p>DIRECTION-BLIND: it compares every primary against every other, so it does not matter
 * which of them is writable nor which was declared first. Comparing against the first
 * primary WRITABLE source can only see a divergence when one of the two is read-only —
 * and, since {@link MetaObject#getSources(boolean)} concatenates OWN sources first and
 * only then walks the super chain, only when the read-only one is the OWN one. That is the
 * REVERSE of TypeScript and C#, whose effective-children walk starts from the super's list
 * and appends own — so the same comparison was blind to opposite shapes per port, and on
 * the JVM it was blind to both shapes the tests now pin (an own writable table beside an
 * inherited read-only view, and two writable primaries). Do not restate this ordering from
 * another port's copy of this doc; the two families genuinely differ.</p>
 *
 * <p>Two primaries AGREEING on a name is not a divergence and stays legal: the invariant
 * is that an object has ONE physical name, not that it declares one source. A read-only
 * primary beside a non-primary REPLICA does not reach it either — a replica is not
 * {@code role == primary}.</p>
 */
public final class SourceResolution {

    private SourceResolution() {}

    /**
     * Every {@code @role: primary} source of {@code obj}, RESOLVING through the
     * {@code extends} super chain (ADR-0039) — an entity inheriting its {@code source.rdb}
     * from an abstract base must see it, or it would wrongly read as unpersisted.
     *
     * <p>Private: nothing outside this class needs the LIST. The two public entry points
     * below are the whole surface — a caller either wants the resolved primary or only
     * wants the refusal, and no third shape has a use.</p>
     *
     * @param obj the object to inspect
     * @return the primary sources, in resolving order (own first, then the super chain)
     */
    private static List<MetaSource> primaryRdbSources(MetaObject obj) {
        List<MetaSource> primaries = new ArrayList<>();
        for (MetaSource src : obj.getSources(true)) {
            if (MetaSource.ROLE_PRIMARY.equals(src.getRole())) primaries.add(src);
        }
        return primaries;
    }

    /**
     * The role-scoped PRIMARY source of {@code obj}, or {@code null} when it has none
     * (#248: participation in the database derives from a declared primary source, never
     * from the object subtype). Runs {@link #refuseDivergentPrimaries} first, so every
     * caller inherits the refusal.
     *
     * @param obj the object to resolve
     * @return the primary source, or {@code null}
     */
    public static MetaSource primaryRdbSource(MetaObject obj) {
        List<MetaSource> primaries = primaryRdbSources(obj);
        refuseDivergentPrimaries(obj, primaries);
        return primaries.isEmpty() ? null : primaries.get(0);
    }

    /**
     * Refuse {@code obj} when its {@code @role: primary} sources disagree on a physical
     * name. See the class doc for the reachability analysis and for why the check is
     * direction-blind.
     *
     * @param obj the object to check
     * @throws MetaDataException when two or more primaries resolve different physical names
     */
    public static void refuseDivergentPrimaries(MetaObject obj) {
        refuseDivergentPrimaries(obj, primaryRdbSources(obj));
    }

    /**
     * The refusal itself, over a primary list the caller already has. ONE implementation
     * and ONE copy of the message: a check written twice is a check that can disagree with
     * itself, which is the same defect one level down from the one this class prevents (a
     * NAME resolved twice). The message is a cross-port contract string — the other four
     * ports carry it verbatim.
     */
    private static void refuseDivergentPrimaries(MetaObject obj, List<MetaSource> primaries) {
        List<String> distinct = primaries.stream()
            .map(MetaSource::getPhysicalName).distinct().sorted().toList();
        if (distinct.size() <= 1) return;
        // Sorted, so the message is identical in every port regardless of source order.
        String joined = distinct.stream().map(n -> "\"" + n + "\"").collect(Collectors.joining(", "));
        throw new MetaDataException(
            obj.getName() + ": role=primary sources disagree on the object's physical name — "
                + joined + ". Every consumer binds ONE name. Give them matching physical "
                + "names, or drop the extra role=primary declaration.");
    }
}
