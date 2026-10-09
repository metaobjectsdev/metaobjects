package com.metaobjects.requirement;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.io.util.IOUtil;
import com.metaobjects.library.LibrarySources;
import com.metaobjects.loader.ValidationPhase;
import com.metaobjects.object.MetaObject;
import com.metaobjects.validation.SymbolTable;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The requirement gate ({@code verify}): reads the {@code requirement.*} nodes of a loaded
 * model and reports what the loader cannot (ADR-0057).
 *
 * <p>Java port of the TypeScript reference, {@code requirement-check.ts}. The codes, their
 * conditions, their ORDER and their message text are copied from it, and the shared
 * {@code fixtures/requirement-check-conformance/} corpus holds this port to it. The loader
 * owns the {@code @status} enum, the required attributes and the child rules; this class
 * owns {@code @implementedBy} resolution, whose severity depends on {@code @status}, and
 * the rules that need the whole ledger.</p>
 *
 * <p>What a clean run proves is referential integrity. It never proves that a status is
 * true or that a claimed node implements the requirement claiming it.</p>
 */
public final class RequirementCheck {

    private RequirementCheck() {}

    public enum Severity { ERROR, WARN }

    /**
     * One finding. {@code path} is the subject's address, the dotted chain of requirement
     * names with no package, or {@code null} when the subject is an entity (coverage).
     */
    public record Diagnostic(Severity severity, String code, String path, String message) {}

    /** A requirement paired with its ADDRESS: the dotted chain of requirement names from the root. */
    public record Addressed(MetaRequirement node, String path) {}

    /**
     * @param measureCoverage force coverage on or off; {@code null} derives it from who authored
     *                        the requirements (see {@code projectAuthoredRequirements})
     * @param requireImplementers the strict switch: raise {@link #WARN_REQUIREMENT_NOTHING_IMPLEMENTS}
     *                            to an error
     */
    public record Options(Boolean measureCoverage, boolean requireImplementers) {}

    /**
     * What one run computes once and both the gate and the summary read, so the printed
     * summary cannot disagree with the diagnostics beneath it.
     */
    public record Scan(List<Addressed> addressed, Set<String> claimedObjects, boolean measureCoverage,
                       boolean requireImplementers, SymbolTable symbols) {}

    /**
     * Counts behind the summary line printed on every run, clean or not.
     * {@code entitiesTotal} and {@code entitiesClaimed} are {@code null} when coverage was
     * not measured: absence is the honest reading of "this project authored no requirement".
     */
    public record Summary(int total, int functional, int architectural, Map<String, Integer> byStatus,
                          int undecided, int deferredUntracked, Integer entitiesClaimed, Integer entitiesTotal) {}

    public static final String ERR_REQUIREMENT_LINK_ABOVE_FLOOR = "ERR_REQUIREMENT_LINK_ABOVE_FLOOR";
    public static final String ERR_REQUIREMENT_DANGLING_REF = "ERR_REQUIREMENT_DANGLING_REF";
    public static final String ERR_REQUIREMENT_BAD_LEVEL = "ERR_REQUIREMENT_BAD_LEVEL";
    public static final String ERR_REQUIREMENT_LEVEL_NESTING = "ERR_REQUIREMENT_LEVEL_NESTING";
    public static final String ERR_REQUIREMENT_L4_NOT_OBJECT = "ERR_REQUIREMENT_L4_NOT_OBJECT";
    public static final String ERR_REQUIREMENT_L5_NOT_MEMBER = "ERR_REQUIREMENT_L5_NOT_MEMBER";
    public static final String ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS = "ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS";
    public static final String WARN_REQUIREMENT_OBJECT_UNCLAIMED = "WARN_REQUIREMENT_OBJECT_UNCLAIMED";
    public static final String WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE = "WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE";
    public static final String WARN_REQUIREMENT_DEFERRED_UNTRACKED = "WARN_REQUIREMENT_DEFERRED_UNTRACKED";
    public static final String WARN_REQUIREMENT_NOTHING_IMPLEMENTS = "WARN_REQUIREMENT_NOTHING_IMPLEMENTS";

    /**
     * Severity of the object-coverage gate. It stays a warning: on a real estate with a single
     * requirement it reports every entity, and at error a project adopting requirements
     * incrementally would fail its first verify after authoring one entry.
     */
    public static final Severity OBJECT_COVERAGE_SEVERITY = Severity.WARN;

    // ------------------------------------------------------------------
    // the walk
    // ------------------------------------------------------------------

    /**
     * Every {@code requirement.*} node in the tree, at any nesting depth, each with its dotted
     * path. Hierarchy IS nesting, so this is a walk. It descends through EVERY node, not only
     * through requirements: a requirement somewhere the child rules did not anticipate is still
     * gated, which is the fail-closed direction for a gate. Only a requirement contributes a
     * path segment.
     */
    public static List<Addressed> collectAddressed(MetaRoot root) {
        List<Addressed> out = new ArrayList<>();
        walk(root, "", out);
        return out;
    }

    private static void walk(MetaData node, String prefix, List<Addressed> out) {
        for (MetaData c : RequirementClaims.structuralChildren(node)) {
            boolean isReq = MetaRequirement.TYPE_REQUIREMENT.equals(c.getType());
            // The bare name: a root-level node's getName() is package-qualified in this port.
            String path = isReq ? (prefix.isEmpty() ? c.getShortName() : prefix + "." + c.getShortName()) : prefix;
            if (isReq) out.add(new Addressed((MetaRequirement) c, path));
            walk(c, path, out);
        }
    }

    /**
     * The package a requirement resolves references in: its own, else the package of the nearest
     * enclosing node that carries one (nested nodes carry bare names, so the declaring root-level
     * node holds the file's package), else {@code ""}.
     */
    public static String effectivePackage(MetaData node) {
        for (MetaData n = node; n != null && !(n instanceof MetaRoot); n = n.getParent()) {
            String pkg = n.getPackage();
            if (pkg != null && !pkg.isEmpty()) return pkg;
        }
        return "";
    }

    // ------------------------------------------------------------------
    // the scan
    // ------------------------------------------------------------------

    public static Scan scan(MetaRoot root, Options options) {
        List<Addressed> addressed = collectAddressed(root);
        SymbolTable symbols = SymbolTable.build(root);
        boolean measure = options.measureCoverage() != null
            ? options.measureCoverage()
            : projectAuthoredRequirements(addressed);
        return new Scan(addressed, claimedObjectKeys(root, symbols, addressed), measure,
            options.requireImplementers(), symbols);
    }

    /**
     * Did the ADOPTER author any of these requirements? A library ships its own ledger, and
     * without this, opting into a library would switch the unclaimed-entity gate on across a
     * project that has never written a requirement. Provenance is the library's declared
     * PACKAGE. An overlay on a library requirement stays in the library's package and does not
     * activate coverage.
     */
    private static boolean projectAuthoredRequirements(List<Addressed> addressed) {
        Set<String> libraryPackages = LibrarySources.libraryPackages();
        for (Addressed a : addressed) {
            if (!libraryPackages.contains(effectivePackage(a.node()))) return true;
        }
        return false;
    }

    /**
     * Resolution keys of every object claimed by a requirement. Shared by the gate and the
     * summary. A PLANNED requirement never contributes. An ARCHITECTURAL claim also covers every
     * root-level object whose resolved super chain reaches the owner; a functional claim does not.
     */
    private static Set<String> claimedObjectKeys(MetaRoot root, SymbolTable symbols, List<Addressed> addressed) {
        Set<String> claimed = new HashSet<>();
        for (Addressed a : addressed) {
            MetaRequirement req = a.node();
            if (req.isPlanned()) continue;
            String referrerPkg = effectivePackage(req);
            for (String ref : req.getImplementedBy()) {
                RequirementClaims.MemberRef split = RequirementClaims.splitMemberRef(ref);
                MetaData node = RequirementClaims.resolveClaimTarget(root, symbols, split.owner(), referrerPkg);
                if (node == null) continue;
                if (!split.path().isEmpty() && RequirementClaims.resolveMember(node, split.path()) == null) continue;
                claimed.add(node.getName());
                if (req.isArchitectural()) claimed.addAll(subtypesOf(root, node));
            }
        }
        return claimed;
    }

    /** Resolution keys of every root-level object whose RESOLVED super chain reaches {@code ancestor}. */
    private static List<String> subtypesOf(MetaRoot root, MetaData ancestor) {
        List<String> out = new ArrayList<>();
        for (MetaData cand : RequirementClaims.structuralChildren(root)) {
            if (!MetaObject.TYPE_OBJECT.equals(cand.getType()) || cand == ancestor) continue;
            Set<MetaData> seen = Collections.newSetFromMap(new java.util.IdentityHashMap<>());
            MetaData cur = cand.getSuperData();
            while (cur != null && seen.add(cur)) {
                if (cur == ancestor) {
                    out.add(cand.getName());
                    break;
                }
                cur = cur.getSuperData();
            }
        }
        return out;
    }

    /**
     * The entities object coverage measures: root-level, non-abstract {@code object.entity}.
     * {@code object.value} and {@code object.projection} are exempt.
     */
    private static List<MetaData> coverableEntities(MetaRoot root) {
        List<MetaData> out = new ArrayList<>();
        for (MetaData n : RequirementClaims.structuralChildren(root)) {
            // ADR-0039 sanctioned own-only read: abstractness describes THIS declaration and is
            // never inherited, so IOUtil.isAbstract reads @isAbstract own-only.
            if (MetaObject.TYPE_OBJECT.equals(n.getType()) && MetaObject.SUBTYPE_ENTITY.equals(n.getSubType()) && !IOUtil.isAbstract(n)) {
                out.add(n);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // the gate
    // ------------------------------------------------------------------

    /**
     * Check the requirement tree against the loaded model. No requirements: no diagnostics.
     * Rows are evaluated per requirement in the order of the reference's code table; object
     * coverage runs once, after every requirement.
     */
    public static List<Diagnostic> check(MetaRoot root, Scan scan) {
        List<Diagnostic> out = new ArrayList<>();
        if (scan.addressed().isEmpty()) return out; // opt-in by declaration

        Map<String, MetaRequirement> ledger = ledgerIndex(scan.addressed());

        for (Addressed a : scan.addressed()) {
            MetaRequirement req = a.node();
            String reqPath = a.path();
            boolean architectural = req.isArchitectural();
            Integer level = req.getLevel();
            List<String> refs = req.getImplementedBy();

            // -- the level rules ------------------------------------------------
            // A functional requirement MUST be levelled. An architectural one MAY be, and
            // levelling is the opt-in: unlevelled it is a flat policy these rules do not touch.
            boolean levelled = level != null;
            if (!architectural || levelled) {
                if (!levelled || level < MetaRequirement.MIN_LEVEL || level > MetaRequirement.MAX_LEVEL) {
                    out.add(error(ERR_REQUIREMENT_BAD_LEVEL, reqPath,
                        "level must be an integer " + MetaRequirement.MIN_LEVEL + "-" + MetaRequirement.MAX_LEVEL
                            + " (got " + show(level) + "). "
                            + "L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member."
                            + (architectural
                                ? " On an architectural requirement the level is optional — omit it for a flat policy."
                                : "")));
                }
                // Nesting IS the hierarchy, so a child must sit strictly below its parent.
                MetaData parent = req.getParent();
                if (parent instanceof MetaRequirement parentReq) {
                    Integer pl = parentReq.getLevel();
                    if (pl != null && level != null && level <= pl) {
                        out.add(error(ERR_REQUIREMENT_LEVEL_NESTING, reqPath,
                            "nested under \"" + parent.getShortName() + "\" (level " + pl + ") but declares level "
                                + level + ". Nesting is the hierarchy — a child sits strictly below its parent."));
                    }
                }
            }

            // -- the link boundary ----------------------------------------------
            if (!refs.isEmpty() && !req.mayReferenceModel()) {
                out.add(error(ERR_REQUIREMENT_LINK_ABOVE_FLOOR, reqPath,
                    "'implementedBy' is legal at L" + MetaRequirement.LINK_FLOOR_LEVEL + " (object) and L"
                        + MetaRequirement.MAX_LEVEL + " (member) only. L1-L3 are organisational and never reference "
                        + "the model — move the links to a nested L" + MetaRequirement.LINK_FLOOR_LEVEL + " child."));
                continue;
            }

            String referrerPkg = effectivePackage(req);
            for (String ref : refs) {
                RequirementClaims.MemberRef split = RequirementClaims.splitMemberRef(ref);
                MetaData node = RequirementClaims.resolveClaimTarget(root, scan.symbols(), split.owner(), referrerPkg);
                boolean isObjectRef = split.path().isEmpty();

                // GRAIN stays functional-only: on a levelled architectural requirement the upper
                // tiers are a quality taxonomy, so a claim set may legitimately mix grains.
                if (!architectural && level != null && level == MetaRequirement.LINK_FLOOR_LEVEL && !isObjectRef) {
                    out.add(error(ERR_REQUIREMENT_L4_NOT_OBJECT, reqPath,
                        "L" + MetaRequirement.LINK_FLOOR_LEVEL + " references an object; '" + ref + "' names a member. "
                            + "Move it to a nested L" + MetaRequirement.LEVEL_MEMBER + " child, or reference the object itself."));
                    continue;
                }
                if (!architectural && level != null && level == MetaRequirement.LEVEL_MEMBER && isObjectRef) {
                    out.add(error(ERR_REQUIREMENT_L5_NOT_MEMBER, reqPath,
                        "L" + MetaRequirement.LEVEL_MEMBER + " references a member (field, view or identity); '" + ref
                            + "' names an object. Move it to its L" + MetaRequirement.LINK_FLOOR_LEVEL + " parent."));
                    continue;
                }

                boolean resolved = node != null && (isObjectRef || RequirementClaims.resolveMember(node, split.path()) != null);
                // Severity is CONDITIONAL ON STATUS: on `planned` the nodes do not exist YET.
                if (!resolved && req.requiresLiveNodes()) {
                    // The hint answers an OBJECT that failed to resolve; when the object resolved
                    // and only the member is gone, name the member instead.
                    String hint = node == null
                        ? ValidationPhase.didYouMeanHint(root, split.owner())
                        : missingMemberHint(node, split.path());
                    out.add(error(ERR_REQUIREMENT_DANGLING_REF, reqPath,
                        "'" + ref + "' does not resolve in the loaded model (status '" + show(req.getStatus())
                            + "' — the model moved and the requirement is stale)." + hint));
                }
            }

            // -- @supersededBy resolution (FR-039) --------------------------------
            // Resolved against the LEDGER, not the model: a capability is replaced by another one.
            String superseded = req.getSupersededBy();
            if (superseded != null && resolveRequirementRef(ledger, superseded, referrerPkg) == null) {
                out.add(error(ERR_REQUIREMENT_DANGLING_REF, reqPath,
                    "@supersededBy '" + superseded + "' does not name a requirement in the loaded "
                        + "ledger. It must name the requirement that REPLACED this one — if nothing did, "
                        + "drop the attribute and let `notes` carry why the capability went."));
            }

            // -- architectural universality: claim-set arithmetic -------------------
            String status = req.getStatus();
            boolean live = req.requiresLiveNodes();
            if (architectural && live && refs.isEmpty() && req.mayReferenceModel()) {
                out.add(error(ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS, reqPath,
                    "architectural requirement is '" + show(status) + "' but nothing implements it. "
                        + "Its check is universality — a claim set of zero means the policy is declared and unapplied."));
            }

            // -- disposition: the decision, not the state -------------------------
            String disposition = req.getDisposition();
            if (disposition != null && !req.hasOutstandingWork()) {
                out.add(warn(WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE, reqPath,
                    "carries @disposition '" + disposition + "' but its status is '" + show(status) + "', which has no "
                        + "outstanding work to decide about. A disposition is meaningful on 'planned' and 'partial' only — "
                        + "on any other status the decision IS the status."));
            }

            // -- functional existence, SUBTREE-scoped -----------------------------
            // The strict switch raises the SEVERITY only; the code keeps its WARN_ name because it
            // identifies the finding.
            if (!architectural && live && !subtreeClaimsAnything(req)) {
                out.add(new Diagnostic(scan.requireImplementers() ? Severity.ERROR : Severity.WARN,
                    WARN_REQUIREMENT_NOTHING_IMPLEMENTS, reqPath,
                    "is '" + show(status) + "' but neither it nor anything nested under it names an "
                        + "implementing node. A functional requirement's check is existence — a subtree that claims "
                        + "nothing is a capability nobody built."));
            }

            if (MetaRequirement.DISPOSITION_DEFERRED.equals(disposition) && req.getTrackedBy().isEmpty()) {
                out.add(warn(WARN_REQUIREMENT_DEFERRED_UNTRACKED, reqPath,
                    "is deferred but names no @trackedBy issue. Deferring without a ticket is how a known gap "
                        + "becomes an unknown one — nothing will raise it again."));
            }
        }

        // -- object coverage: adding an entity forces a requirement ---------------
        // Binary per entity, object grain only, adopter-authored requirements only.
        if (scan.measureCoverage()) {
            for (MetaData ent : coverableEntities(root)) {
                String key = ent.getName();
                if (!scan.claimedObjects().contains(key)) {
                    out.add(new Diagnostic(OBJECT_COVERAGE_SEVERITY, WARN_REQUIREMENT_OBJECT_UNCLAIMED, null,
                        "no requirement claims '" + key + "'. Add it to an L" + MetaRequirement.LINK_FLOOR_LEVEL
                            + " requirement's 'implementedBy'."));
                }
            }
        }
        return out;
    }

    private static Diagnostic error(String code, String path, String message) {
        return new Diagnostic(Severity.ERROR, code, path, message);
    }

    private static Diagnostic warn(String code, String path, String message) {
        return new Diagnostic(Severity.WARN, code, path, message);
    }

    /** The reference prints a missing value as {@code undefined}. */
    private static String show(Object value) {
        return value == null ? "undefined" : String.valueOf(value);
    }

    /**
     * Names the FIRST segment of a non-empty, unresolvable {@code path} under {@code obj}, and
     * the node it was looked for under: {@code acme::shop::Order.reference.display} with
     * {@code reference} still present reads "'acme::shop::Order.reference' has no member
     * 'display'", not the whole tail.
     */
    private static String missingMemberHint(MetaData obj, List<String> path) {
        int found = 0;
        while (found < path.size() - 1 && RequirementClaims.resolveMember(obj, path.subList(0, found + 1)) != null) found++;
        List<String> parent = new ArrayList<>();
        parent.add(obj.getName());
        parent.addAll(path.subList(0, found));
        return " '" + String.join(".", parent) + "' has no member '" + path.get(found) + "'.";
    }

    /**
     * True when this requirement, or anything nested beneath it, names an implementing node.
     * Subtree-scoped deliberately: a parent that delegates everything to its children implements
     * nothing directly, and flagging that would fire on the correct shape of every tree.
     * Existence is about NAMING, not resolving.
     */
    private static boolean subtreeClaimsAnything(MetaRequirement req) {
        if (!req.getImplementedBy().isEmpty()) return true;
        for (MetaRequirement child : req.getChildRequirements()) {
            if (subtreeClaimsAnything(child)) return true;
        }
        return false;
    }

    /**
     * The ledger index {@code @supersededBy} resolves against: {@code <effective package>::<path>}
     * for every packaged requirement, and the bare {@code <path>} (first one wins).
     */
    private static Map<String, MetaRequirement> ledgerIndex(List<Addressed> addressed) {
        Map<String, MetaRequirement> keyed = new HashMap<>();
        for (Addressed a : addressed) {
            String pkg = effectivePackage(a.node());
            if (!pkg.isEmpty()) keyed.put(pkg + MetaData.PKG_SEPARATOR + a.path(), a.node());
            keyed.putIfAbsent(a.path(), a.node());
        }
        return keyed;
    }

    /** An FQN binds exactly; a bare ref prefers the referrer's own package. */
    private static MetaRequirement resolveRequirementRef(Map<String, MetaRequirement> ledger, String ref, String referrerPkg) {
        MetaRequirement exact = ledger.get(ref);
        if (exact != null) return exact;
        if (!referrerPkg.isEmpty()) return ledger.get(referrerPkg + MetaData.PKG_SEPARATOR + ref);
        return null;
    }

    // ------------------------------------------------------------------
    // the summary
    // ------------------------------------------------------------------

    /**
     * Count what the ledger contains, for the line printed on EVERY run, including a clean one.
     *
     * @return the counts, or {@code null} when the model declares no requirement
     */
    public static Summary summarise(MetaRoot root, Scan scan) {
        if (scan.addressed().isEmpty()) return null; // opt-in by declaration

        // `undecided` counts only the requirements a @disposition could actually SETTLE. Every
        // ANCESTOR of a node with outstanding work is a roll-up and is excluded, whether or not
        // the descendant has a disposition. Ancestry is by dotted path SEGMENT, not by string
        // prefix: `DeliveryNote` is not under `Delivery`.
        Set<String> rollUpAncestors = new HashSet<>();
        for (Addressed a : scan.addressed()) {
            if (!a.node().hasOutstandingWork()) continue;
            String[] segments = a.path().split("\\.", -1);
            for (int i = 1; i < segments.length; i++) {
                rollUpAncestors.add(String.join(".", java.util.Arrays.asList(segments).subList(0, i)));
            }
        }

        int functional = 0, architectural = 0, undecided = 0, deferredUntracked = 0;
        Map<String, Integer> byStatus = new LinkedHashMap<>();
        for (Addressed a : scan.addressed()) {
            MetaRequirement req = a.node();
            if (req.isArchitectural()) architectural++;
            else functional++;
            if (req.getStatus() != null) byStatus.merge(req.getStatus(), 1, Integer::sum);
            if (req.hasOutstandingWork() && req.getDisposition() == null && !rollUpAncestors.contains(a.path())) undecided++;
            if (MetaRequirement.DISPOSITION_DEFERRED.equals(req.getDisposition()) && req.getTrackedBy().isEmpty()) deferredUntracked++;
        }

        Integer entitiesClaimed = null;
        Integer entitiesTotal = null;
        if (scan.measureCoverage()) {
            int total = 0, claimedCount = 0;
            for (MetaData ent : coverableEntities(root)) {
                total++;
                if (scan.claimedObjects().contains(ent.getName())) claimedCount++;
            }
            entitiesClaimed = claimedCount;
            entitiesTotal = total;
        }
        return new Summary(scan.addressed().size(), functional, architectural, byStatus, undecided,
            deferredUntracked, entitiesClaimed, entitiesTotal);
    }

    // ------------------------------------------------------------------
    // what verify prints (everything after the port's own command prefix)
    // ------------------------------------------------------------------

    /**
     * {@code requirements: <total> entries (...) — <n> <status>, ...; } then either the
     * not-measured sentence or {@code <claimed>/<total> entities claimed, counted over <files>
     * metadata file(s).} Statuses appear in declaration order, zero counts omitted.
     */
    public static String summaryText(Summary s, int metadataFiles) {
        List<String> parts = new ArrayList<>();
        for (String status : MetaRequirement.STATUSES) {
            int n = s.byStatus().getOrDefault(status, 0);
            if (n > 0) parts.add(n + " " + status);
        }
        return "requirements: " + s.total() + " entries (" + s.functional() + " functional, "
            + s.architectural() + " architectural) — " + String.join(", ", parts) + "; "
            + (s.entitiesTotal() == null
                ? "coverage: not measured (no project-authored requirements)."
                : s.entitiesClaimed() + "/" + s.entitiesTotal() + " entities claimed, counted over "
                    + metadataFiles + " metadata file(s).");
    }

    /** The recorded-gaps line, or {@code null} when nothing is undecided. */
    public static String undecidedText(Summary s) {
        if (s.undecided() <= 0) return null;
        return "requirements: " + s.undecided() + " recorded gap(s) with no @disposition. "
            + "These are known problems nobody has ruled on — set 'accepted' or 'deferred' to close the question.";
    }

    /** {@code  <code> [<path>]: <message>}, or {@code  <code>: <message>} when there is no path. */
    public static String formatDiagnostic(Diagnostic d) {
        return "  " + d.code() + (d.path() == null ? "" : " [" + d.path() + "]") + ": " + d.message();
    }
}
