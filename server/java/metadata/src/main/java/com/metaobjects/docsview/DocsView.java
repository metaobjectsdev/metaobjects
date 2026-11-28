package com.metaobjects.docsview;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.documentation.DocumentationConstants;
import com.metaobjects.field.MetaField;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.References;
import com.metaobjects.object.MetaObject;
import com.metaobjects.requirement.MetaRequirement;
import com.metaobjects.requirement.RequirementCheck;
import com.metaobjects.requirement.RequirementClaims;
import com.metaobjects.template.TemplateConstants;
import com.metaobjects.validation.SymbolTable;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * The docs view of a loaded model: one port-neutral document, the facts every documentation page
 * reads, and what the model explorer draws ({@code docs/features/docs-view.md}).
 *
 * <p>The Java port of TypeScript's {@code buildDocsView} ({@code @metaobjectsdev/metadata},
 * {@code src/docs-view/build.ts}), held to the same bytes by {@code fixtures/explorer-conformance/}.
 * It reads the model the loader built and resolved, and re-derives none of it: ids and pages from
 * the effective tree walked once in declaration order (the canonical serializer's effective
 * children, which follow TypeScript's order); inheritance from a child whose parent is another
 * node; references from the loader's own resolution ({@link MetaAttribute#getResolvedTarget()},
 * {@link MetaData#getSuperData()}); claims through the resolver the requirement gate uses.</p>
 *
 * <p>Three optional inputs add what the model does not hold, each as parsed JSON and each left out
 * when {@code null} or malformed: the {@code meta verify --format json} payload, the generation
 * manifest ({@code path → { generatedBy, sourceNode }}) and the routes ({@code [{ node, method,
 * path }]}). The result is deterministic: {@link #serialize} gives the same bytes for the same
 * inputs.</p>
 */
public final class DocsView {

    /** Bumped when a field changes meaning or is removed. */
    public static final String FORMAT = "metaobjects-docs-view/1";

    private static final String CODE_OBJECT_UNCLAIMED = RequirementCheck.WARN_REQUIREMENT_OBJECT_UNCLAIMED;
    private static final String EXTENDS = "extends";
    private static final String PKG = MetaData.PKG_SEPARATOR;
    private static final String DOT = ".";
    private static final String TYPE_SUB = ".";
    private static final String NUL = "\u0000";

    private DocsView() {}

    /** The file's bytes: two-space JSON and one trailing newline. */
    public static String serialize(JsonObject view) {
        return DocsViewJson.pretty(view) + "\n";
    }

    /** The docs view of the model alone. */
    public static JsonObject build(MetaRoot root) {
        return build(root, null, null, null);
    }

    /**
     * Build the docs view. {@code verify}, {@code manifest} and {@code routes} are optional
     * (null); a malformed one only leaves its part out.
     */
    public static JsonObject build(MetaRoot root, JsonElement verify, JsonElement manifest, JsonElement routes) {
        return new Build(root).run(verify, manifest, routes);
    }

    // ------------------------------------------------------------------
    // the walk
    // ------------------------------------------------------------------

    /** A node as walked: where it sits, and the ids and pages it gets. */
    private static final class Walked {
        MetaData md;
        String id;
        String plain;
        Walked top;
        Walked parent;
        Walked direct;
        Walked requirement;
        int order;
        boolean canonical;
        MetaData declaredOn;
        String anchor = "";
        String path = "";
        final List<Walked> children = new ArrayList<>();
        String address = "";
    }

    private record Ledger(String qualifiedPath, String digest, String verdict, JsonArray diagnostics,
                          String supRef, boolean supResolves, String supTarget, boolean hasSup) {}

    private static final class Build {
        final MetaRoot root;
        final SymbolTable symbols;
        final List<Walked> walked = new ArrayList<>();
        final List<Walked> tops = new ArrayList<>();
        final Map<String, Walked> byId = new HashMap<>();
        final Map<MetaData, Walked> canonical = new IdentityHashMap<>();
        final Map<String, Walked> byPlain = new HashMap<>();
        final List<Walked> requirements = new ArrayList<>();
        final Map<MetaData, String> holderType = new HashMap<>();

        Build(MetaRoot root) {
            this.root = root;
            this.symbols = SymbolTable.build(root);
            walk();
        }

        private void walk() {
            List<MetaData> topLevel = children(root);
            // Top-level nodes of different types may share a package and a name. The object keeps
            // the plain id, since every reference in the model names an object, else the first
            // declared; each other one is qualified by its type.
            Map<String, MetaData> holder = new HashMap<>();
            for (MetaData md : topLevel) {
                String id = plainOf(md);
                MetaData held = holder.get(id);
                if (held == null || (!MetaObject.TYPE_OBJECT.equals(held.getType()) && MetaObject.TYPE_OBJECT.equals(md.getType()))) {
                    holder.put(id, md);
                }
            }
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < topLevel.size(); i++) visit(topLevel.get(i), i, null, "", holder, seen);
            for (Walked w : walked) w.path = pathOf(w);
        }

        private void visit(MetaData md, int index, Walked parent, String reqPrefix,
                           Map<String, MetaData> holder, Set<String> seen) {
            String name = nameOf(md);
            String id;
            String plain;
            if (parent == null) {
                plain = name.isEmpty() ? "#" + index : plainOf(md);
                id = plain;
                MetaData held = holder.get(plain);
                if (!name.isEmpty() && held != md && (held == null || !held.getType().equals(md.getType()))) {
                    id = qualified(plain, md);
                }
            } else {
                plain = name.isEmpty() ? parent.plain + "#" + index : parent.plain + DOT + name;
                id = name.isEmpty() ? parent.id + "#" + index : parent.id + DOT + name;
                // The first sibling of a name keeps the plain id; a later one of another type is
                // qualified by type.
                if (!name.isEmpty() && seen.contains(id)) id = qualified(id, md);
            }
            if (seen.contains(id)) {
                throw new IllegalStateException("docs view: two nodes share the id \"" + id
                    + "\" — the model names two siblings alike");
            }
            seen.add(id);
            boolean isReq = MetaRequirement.TYPE_REQUIREMENT.equals(md.getType());
            String address = isReq ? (reqPrefix.isEmpty() ? name : reqPrefix + DOT + name) : reqPrefix;
            boolean inherited = parent != null && md.getParent() != parent.md;
            Walked w = new Walked();
            w.md = md;
            w.id = id;
            w.plain = plain;
            w.parent = parent;
            w.order = index;
            w.canonical = parent == null || (parent.canonical && !inherited);
            w.declaredOn = inherited ? md.getParent() : null;
            w.address = isReq ? address : "";
            w.top = parent == null ? w : parent.top;
            w.direct = parent == null ? null : parent.parent == null ? w : parent.direct;
            w.requirement = isReq ? w : parent == null ? null : parent.requirement;
            if (w.direct == w) w.anchor = memberAnchor(md, name, index);
            walked.add(w);
            byId.put(id, w);
            if (w.top.id.equals(w.top.plain) && !byPlain.containsKey(plain)) byPlain.put(plain, w);
            if (w.canonical) canonical.put(md, w);
            if (parent == null) tops.add(w);
            else parent.children.add(w);
            if (isReq) requirements.add(w);
            List<MetaData> kids = children(md);
            for (int i = 0; i < kids.size(); i++) visit(kids.get(i), i, w, address, holder, seen);
        }

        private String pathOf(Walked w) {
            if (w.requirement != null) {
                Walked r = w.requirement;
                return "requirements/" + packageDir(References.effectivePackageOf(r.top.md)) + "/" + pageStem(r.address) + ".html";
            }
            Walked top = w.top;
            String qualifier = "[" + top.md.getType() + TYPE_SUB + top.md.getSubType() + "]";
            String typed = top.id.endsWith(qualifier) ? "." + top.md.getType() + "-" + top.md.getSubType() : "";
            String page = "model/" + packageDir(References.effectivePackageOf(top.md)) + "/" + pageStem(nameOf(top.md)) + typed + ".html";
            return w.direct == null ? page : page + "#" + w.direct.anchor;
        }

        JsonObject link(Walked w) {
            String label;
            if (w.requirement == w) {
                String title = strAttr(w.md, DocumentationConstants.DOC_ATTR_TITLE);
                label = title.isEmpty() ? nameOf(w.md) : title;
            } else if (w == w.top) {
                label = nameOf(w.md);
            } else {
                label = nameOf(w.top.md) + w.id.substring(w.top.id.length());
            }
            JsonObject o = new JsonObject();
            o.addProperty("label", label);
            o.addProperty("id", w.id);
            o.addProperty("path", w.path);
            o.addProperty("kind", w.md.getType() + TYPE_SUB + w.md.getSubType());
            o.addProperty("unresolved", false);
            return o;
        }

        JsonObject linkTo(MetaData md, String text) {
            Walked w = md == null ? null : canonical.get(md);
            return w != null ? link(w) : unresolved(text);
        }

        /** The link a reference value lands on: the owner's row for the member its dotted tail
         *  names, else the owner the loader bound. */
        JsonObject refLink(MetaData owner, String value) {
            if (owner == null) return unresolved(value);
            String tail = References.splitChildTail(value).tail();
            Walked row = tail.isEmpty() ? null : byPlain.get(plainOf(owner) + tail);
            return row != null ? link(row) : linkTo(owner, value);
        }

        // --------------------------------------------------------------
        // the build
        // --------------------------------------------------------------

        JsonObject run(JsonElement verifyIn, JsonElement manifest, JsonElement routesIn) {
            Map<String, Deque<Ledger>> ledger = ledgerRows(verifyIn);
            boolean hasVerify = ledger != null;
            JsonObject verify = verifyIn != null && verifyIn.isJsonObject() ? verifyIn.getAsJsonObject() : null;

            // ── Requirements: claims first, since nodes and members list them. ──
            Map<Walked, List<JsonObject>> claimsOn = new IdentityHashMap<>();
            Map<Walked, JsonArray> reqLinks = new IdentityHashMap<>();
            Map<Walked, List<Walked>> reqTargets = new IdentityHashMap<>();
            for (Walked r : requirements) {
                MetaRequirement req = (MetaRequirement) r.md;
                String referrerPkg = RequirementCheck.effectivePackage(req);
                JsonArray links = new JsonArray();
                List<Walked> targets = new ArrayList<>();
                for (String ref : req.getImplementedBy()) {
                    RequirementClaims.MemberRef split = RequirementClaims.splitMemberRef(ref);
                    MetaData node = RequirementClaims.resolveClaimTarget(root, symbols, split.owner(), referrerPkg);
                    MetaData member = node != null && !split.path().isEmpty() ? RequirementClaims.resolveMember(node, split.path()) : node;
                    String key = node == null ? "" : split.path().isEmpty() ? plainOf(node) : plainOf(node) + DOT + String.join(DOT, split.path());
                    Walked w = member != null ? byPlain.get(key) : null;
                    if (w == null) {
                        links.add(reqLink(ref, false, unresolved(ref)));
                        continue;
                    }
                    links.add(reqLink(ref, true, link(w)));
                    targets.add(w);
                    JsonObject claim = new JsonObject();
                    claim.add("requirement", link(r));
                    claim.addProperty("member", w == w.top ? "" : memberPath(w));
                    claim.addProperty("status", str(req.getStatus()));
                    claim.add("level", req.getLevel() == null ? JsonNull.INSTANCE : new JsonPrimitive(req.getLevel()));
                    // The claim is on the top-level node and on every member down to the one it names.
                    for (Walked x = w; x != null; x = x.parent) claimsOn.computeIfAbsent(x, k -> new ArrayList<>()).add(claim);
                }
                reqLinks.put(r, links);
                reqTargets.put(r, targets);
            }

            // ── Files and routes. ──
            Map<Walked, Map<String, List<String>>> filesOf = new IdentityHashMap<>();
            boolean hasManifest = manifest != null && manifest.isJsonObject();
            if (hasManifest) {
                for (Map.Entry<String, JsonElement> e : manifest.getAsJsonObject().entrySet()) {
                    if (!e.getValue().isJsonObject()) continue;
                    JsonObject entry = e.getValue().getAsJsonObject();
                    String sourceNode = stringOrNull(entry, "sourceNode");
                    if (sourceNode == null) continue;
                    Walked w = byPlain.get(sourceNode);
                    if (w == null) continue;
                    filesOf.computeIfAbsent(w.top, k -> new LinkedHashMap<>())
                        .computeIfAbsent(str(stringOrNull(entry, "generatedBy")), k -> new ArrayList<>())
                        .add(e.getKey());
                }
            }
            Map<Walked, Map<String, JsonObject>> routesOf = new IdentityHashMap<>();
            boolean hasRoutes = routesIn != null && routesIn.isJsonArray();
            if (hasRoutes) {
                for (JsonElement el : routesIn.getAsJsonArray()) {
                    if (!el.isJsonObject()) continue;
                    JsonObject r = el.getAsJsonObject();
                    String node = stringOrNull(r, "node");
                    String method = stringOrNull(r, "method");
                    String path = stringOrNull(r, "path");
                    if (node == null || method == null || path == null) continue;
                    Walked w = byPlain.get(node);
                    if (w == null) continue;
                    JsonObject route = new JsonObject();
                    // JavaScript's toUpperCase, locale-independent.
                    route.addProperty("method", method.toUpperCase(java.util.Locale.ROOT));
                    route.addProperty("path", path);
                    routesOf.computeIfAbsent(w.top, k -> new LinkedHashMap<>())
                        .put(path + NUL + route.get("method").getAsString(), route);
                }
            }

            // ── Advisories. ──
            JsonArray advisories = new JsonArray();
            Set<String> unclaimedIds = new HashSet<>();
            if (hasVerify && verify != null && verify.has("requirements") && verify.get("requirements").isJsonObject()) {
                JsonElement rows = verify.getAsJsonObject("requirements").get("rows");
                if (rows != null && rows.isJsonArray()) {
                    for (JsonElement el : rows.getAsJsonArray()) {
                        if (!el.isJsonObject()) continue;
                        JsonObject d = el.getAsJsonObject();
                        String node = str(stringOrNull(d, "node"));
                        JsonElement subject = node.isEmpty() ? JsonNull.INSTANCE
                            : byPlain.containsKey(node) ? link(byPlain.get(node).top) : unresolved(node);
                        JsonObject a = new JsonObject();
                        a.addProperty("code", str(stringOrNull(d, "code")));
                        a.addProperty("path", str(stringOrNull(d, "path")));
                        a.add("subject", subject);
                        a.addProperty("severity", str(stringOrNull(d, "severity")));
                        a.addProperty("source", str(stringOrNull(d, "source")));
                        a.addProperty("message", str(stringOrNull(d, "message")));
                        advisories.add(a);
                        if (CODE_OBJECT_UNCLAIMED.equals(a.get("code").getAsString()) && subject.isJsonObject()) {
                            unclaimedIds.add(subject.getAsJsonObject().get("id").getAsString());
                        }
                    }
                }
            }

            // ── Members and references. ──
            Map<Walked, List<JsonObject>> refsFrom = new IdentityHashMap<>();
            List<JsonObject> nodes = new ArrayList<>();
            Map<Walked, List<JsonObject>> nodeRefs = new IdentityHashMap<>();
            Map<String, JsonObject> nodeById = new HashMap<>();
            for (Walked t : tops) {
                AttrsResult ar = attrsOf(t.md);
                JsonElement ext = extendsLink(t.md);
                JsonArray memberGroups = groupMembers(memberList(t.children, claimsOn, refsFrom));
                List<JsonObject> all = new ArrayList<>();
                if (ext.isJsonObject() && !ext.getAsJsonObject().get("unresolved").getAsBoolean()) {
                    all.add(ref(EXTENDS, JsonNull.INSTANCE, ext.getAsJsonObject()));
                }
                for (Map.Entry<String, JsonObject> r : ar.refs) all.add(ref(r.getKey(), JsonNull.INSTANCE, r.getValue()));
                below(t, refsFrom, all);
                nodeRefs.put(t, all);

                JsonArray files = new JsonArray();
                int fileCount = 0;
                TreeMap<String, List<String>> byGen = new TreeMap<>(filesOf.getOrDefault(t, Map.of()));
                for (Map.Entry<String, List<String>> g : byGen.entrySet()) {
                    List<String> paths = new ArrayList<>(g.getValue());
                    Collections.sort(paths);
                    JsonObject fg = new JsonObject();
                    fg.addProperty("generatedBy", g.getKey());
                    fg.add("paths", strings(paths));
                    files.add(fg);
                    fileCount += paths.size();
                }
                JsonArray routes = new JsonArray();
                for (JsonObject r : new TreeMap<>(routesOf.getOrDefault(t, Map.of())).values()) routes.add(r);

                List<JsonObject> claims = claimsOn.getOrDefault(t, List.of());
                JsonObject n = new JsonObject();
                n.addProperty("id", t.id);
                n.addProperty("name", nameOf(t.md));
                n.addProperty("package", References.effectivePackageOf(t.md));
                n.addProperty("type", t.md.getType());
                n.addProperty("subType", t.md.getSubType());
                n.addProperty("order", t.order);
                n.addProperty("path", t.path);
                n.addProperty("title", strAttr(t.md, DocumentationConstants.DOC_ATTR_TITLE));
                n.addProperty("description", strAttr(t.md, DocumentationConstants.DOC_ATTR_DESCRIPTION));
                n.addProperty("summary", strAttr(t.md, DocumentationConstants.DOC_ATTR_SUMMARY));
                n.addProperty("abstract", isAbstract(t.md));
                n.add("extends", ext);
                n.add("attrs", ar.attrs);
                n.add("memberGroups", memberGroups);
                n.add("refs", array(all));
                n.add("referencedBy", new JsonArray());
                n.add("claims", array(claims));
                n.add("files", files);
                n.add("routes", routes);
                n.addProperty("unclaimed", unclaimedIds.contains(t.id));
                JsonObject counts = new JsonObject();
                counts.addProperty("members", t.children.size());
                counts.addProperty("refs", all.size());
                counts.addProperty("referencedBy", 0);
                counts.addProperty("claims", claims.size());
                counts.addProperty("files", fileCount);
                counts.addProperty("routes", routes.size());
                n.add("counts", counts);
                nodes.add(n);
                nodeById.put(t.id, n);
            }

            // referencedBy: every reference into a top-level node (or a member of it) from another one.
            Map<String, Map<String, JsonObject>> incoming = new LinkedHashMap<>();
            for (Walked t : tops) {
                for (JsonObject r : nodeRefs.getOrDefault(t, List.of())) {
                    JsonObject target = r.getAsJsonObject("target");
                    Walked tw = byId.get(target.get("id").getAsString());
                    if (tw == null || tw.top == t) continue;
                    JsonElement via = r.get("via");
                    JsonObject referrer = new JsonObject();
                    referrer.addProperty("attr", r.get("attr").getAsString());
                    referrer.add("from", link(t));
                    referrer.add("via", via);
                    referrer.add("target", target);
                    String viaId = via.isJsonObject() ? via.getAsJsonObject().get("id").getAsString() : "";
                    String key = String.join(NUL, t.id, r.get("attr").getAsString(), viaId, target.get("id").getAsString());
                    incoming.computeIfAbsent(tw.top.id, k -> new HashMap<>()).put(key, referrer);
                }
            }
            for (Map.Entry<String, Map<String, JsonObject>> e : incoming.entrySet()) {
                JsonObject n = nodeById.get(e.getKey());
                if (n == null) continue;
                JsonArray by = new JsonArray();
                for (JsonObject r : new TreeMap<>(e.getValue()).values()) by.add(r);
                n.add("referencedBy", by);
                n.getAsJsonObject("counts").addProperty("referencedBy", by.size());
            }
            nodes.sort((a, c) -> a.get("id").getAsString().compareTo(c.get("id").getAsString()));

            // ── The requirement list, flat, in document order. ──
            Map<Walked, List<Walked>> reqChildren = new IdentityHashMap<>();
            for (Walked r : requirements) {
                Walked p = reqParent(r);
                if (p != null) reqChildren.computeIfAbsent(p, k -> new ArrayList<>()).add(r);
            }
            List<JsonObject> reqs = new ArrayList<>();
            for (Walked r : requirements) {
                MetaRequirement req = (MetaRequirement) r.md;
                String pkg = RequirementCheck.effectivePackage(req);
                String qualifiedPath = pkg.isEmpty() ? r.address : pkg + PKG + r.address;
                Deque<Ledger> rows = ledger == null ? null : ledger.get(qualifiedPath);
                Ledger row = rows == null ? null : rows.poll();
                List<Walked> chain = new ArrayList<>();
                for (Walked p = reqParent(r); p != null; p = reqParent(p)) chain.add(0, p);
                List<Walked> sub = new ArrayList<>();
                subtree(r, reqChildren, sub);
                List<Walked> linked = new ArrayList<>();
                for (Walked x : sub) {
                    MetaRequirement xr = (MetaRequirement) x.md;
                    Integer level = xr.getLevel();
                    if ((level == null ? 0 : level) >= MetaRequirement.LEVEL_OBJECT
                            || (level == null && !xr.getImplementedBy().isEmpty())) {
                        linked.add(x);
                    }
                }
                List<Walked> counted = linked.isEmpty() ? List.of(r) : linked;
                List<String> statuses = new ArrayList<>();
                for (Walked x : counted) {
                    String s = str(((MetaRequirement) x.md).getStatus());
                    if (!s.isEmpty()) statuses.add(s);
                }
                TreeMap<String, Walked> targetTops = new TreeMap<>();
                for (Walked x : sub) for (Walked w : reqTargets.getOrDefault(x, List.of())) targetTops.putIfAbsent(w.top.id, w.top);
                List<Walked> children = reqChildren.getOrDefault(r, List.of());

                JsonObject o = new JsonObject();
                o.addProperty("id", r.id);
                o.addProperty("name", nameOf(r.md));
                o.addProperty("label", link(r).get("label").getAsString());
                o.addProperty("path", r.path);
                o.addProperty("address", r.address);
                o.addProperty("package", pkg);
                o.addProperty("qualifiedPath", qualifiedPath);
                o.addProperty("subType", r.md.getSubType());
                o.add("level", req.getLevel() == null ? JsonNull.INSTANCE : new JsonPrimitive(req.getLevel()));
                o.addProperty("status", str(req.getStatus()));
                o.addProperty("disposition", str(req.getDisposition()));
                o.addProperty("statement", strAttr(req, MetaRequirement.ATTR_STATEMENT));
                o.addProperty("counterexample", strAttr(req, MetaRequirement.ATTR_COUNTEREXAMPLE));
                o.addProperty("title", strAttr(req, DocumentationConstants.DOC_ATTR_TITLE));
                o.addProperty("description", strAttr(req, DocumentationConstants.DOC_ATTR_DESCRIPTION));
                o.add("trackedBy", strings(req.getTrackedBy()));
                o.addProperty("depth", chain.size());
                o.add("parent", chain.isEmpty() ? JsonNull.INSTANCE : link(chain.get(chain.size() - 1)));
                JsonArray crumbs = new JsonArray();
                for (Walked x : chain) crumbs.add(link(x));
                o.add("breadcrumbs", crumbs);
                JsonArray kids = new JsonArray();
                for (Walked x : children) kids.add(link(x));
                o.add("children", kids);
                o.add("implementedBy", reqLinks.getOrDefault(r, new JsonArray()));
                if (row == null || !row.hasSup()) {
                    o.add("supersededBy", JsonNull.INSTANCE);
                } else {
                    Walked supTarget = null;
                    if (!row.supTarget().isEmpty()) {
                        for (Walked x : requirements) {
                            String p = RequirementCheck.effectivePackage(x.md);
                            if ((p.isEmpty() ? x.address : p + PKG + x.address).equals(row.supTarget())) { supTarget = x; break; }
                        }
                    }
                    o.add("supersededBy", reqLink(row.supRef(), row.supResolves(), supTarget != null ? link(supTarget) : unresolved(row.supRef())));
                }
                o.addProperty("inLedger", row != null);
                o.addProperty("verdict", row == null ? "" : row.verdict());
                o.addProperty("digest", row == null ? "" : row.digest());
                o.add("diagnostics", row == null ? new JsonArray() : row.diagnostics());
                o.add("rollup", statusCounts(statuses));
                o.addProperty("rollupTotal", statuses.size());
                o.addProperty("belowCount", sub.size() - 1);
                o.addProperty("childCount", children.size());
                JsonArray targets = new JsonArray();
                for (Walked w : targetTops.values()) targets.add(link(w));
                o.add("targets", targets);
                o.addProperty("targetCount", targetTops.size());
                reqs.add(o);
            }

            // ── Packages, counts, slices. ──
            TreeSet<String> pkgNames = new TreeSet<>();
            for (JsonObject n : nodes) pkgNames.add(n.get("package").getAsString());
            JsonArray packages = new JsonArray();
            for (String name : pkgNames) {
                TreeMap<String, JsonObject> groups = new TreeMap<>();
                int count = 0;
                for (JsonObject n : nodes) {
                    if (!n.get("package").getAsString().equals(name)) continue;
                    count++;
                    String type = n.get("type").getAsString();
                    String subType = n.get("subType").getAsString();
                    JsonObject g = groups.computeIfAbsent(type + TYPE_SUB + subType, k -> {
                        JsonObject x = new JsonObject();
                        x.addProperty("type", type);
                        x.addProperty("subType", subType);
                        x.addProperty("count", 0);
                        x.add("nodes", new JsonArray());
                        return x;
                    });
                    g.addProperty("count", g.get("count").getAsInt() + 1);
                    g.getAsJsonArray("nodes").add(link(byId.get(n.get("id").getAsString())));
                }
                JsonObject p = new JsonObject();
                p.addProperty("name", name);
                p.addProperty("count", count);
                p.add("groups", array(new ArrayList<>(groups.values())));
                packages.add(p);
            }

            JsonObject vc = verify != null && verify.has("requirementCounts") && verify.get("requirementCounts").isJsonObject()
                ? verify.getAsJsonObject("requirementCounts") : null;
            Set<String> allFiles = new HashSet<>();
            int routeCount = 0;
            for (JsonObject n : nodes) {
                for (JsonElement g : n.getAsJsonArray("files")) for (JsonElement p : g.getAsJsonObject().getAsJsonArray("paths")) allFiles.add(p.getAsString());
                routeCount += n.getAsJsonArray("routes").size();
            }
            int functional = 0;
            int architectural = 0;
            int claimCount = 0;
            List<String> reqStatuses = new ArrayList<>();
            for (JsonObject r : reqs) {
                String st = r.get("subType").getAsString();
                if (MetaRequirement.SUBTYPE_FUNCTIONAL.equals(st)) functional++;
                if (MetaRequirement.SUBTYPE_ARCHITECTURAL.equals(st)) architectural++;
                reqStatuses.add(r.get("status").getAsString());
                for (JsonElement l : r.getAsJsonArray("implementedBy")) if (l.getAsJsonObject().get("resolves").getAsBoolean()) claimCount++;
            }
            JsonObject counts = new JsonObject();
            counts.addProperty("nodes", nodes.size());
            counts.addProperty("packages", packages.size());
            counts.addProperty("requirements", reqs.size());
            counts.addProperty("functional", functional);
            counts.addProperty("architectural", architectural);
            counts.add("byStatus", statusCounts(reqStatuses));
            counts.addProperty("claims", claimCount);
            counts.addProperty("files", allFiles.size());
            counts.addProperty("routes", routeCount);
            counts.add("undecided", num(vc, "undecided"));
            counts.addProperty("coverageMeasured", isNumber(vc, "entitiesTotal"));
            counts.add("entitiesClaimed", num(vc, "entitiesClaimed"));
            counts.add("entitiesTotal", num(vc, "entitiesTotal"));

            JsonObject sources = new JsonObject();
            sources.addProperty("requirements", hasVerify);
            sources.addProperty("files", hasManifest);
            sources.addProperty("routes", hasRoutes);

            JsonObject view = new JsonObject();
            view.addProperty("format", FORMAT);
            view.add("sources", sources);
            view.add("counts", counts);
            view.add("packages", packages);
            view.add("nodes", array(nodes));
            view.add("requirements", array(reqs));
            view.add("advisories", advisories);
            view.add("slices", slices(nodes, reqs));
            return view;
        }

        private JsonArray slices(List<JsonObject> nodes, List<JsonObject> reqs) {
            List<JsonObject> slices = new ArrayList<>();
            TreeSet<String> pkgs = new TreeSet<>();
            for (JsonObject n : nodes) pkgs.add(n.get("package").getAsString());
            for (String pkg : pkgs) {
                TreeSet<String> ids = new TreeSet<>();
                for (JsonObject n : nodes) if (n.get("package").getAsString().equals(pkg)) ids.add(n.get("id").getAsString());
                slices.add(slice("package", pkg, ids));
            }
            // A requirement with requirements below it: the subtree, each node it claims, and the
            // top-level node holding a claimed member.
            Map<String, JsonObject> reqById = new HashMap<>();
            for (JsonObject r : reqs) reqById.put(r.get("id").getAsString(), r);
            for (JsonObject r : reqs) {
                if (r.get("childCount").getAsInt() == 0) continue;
                TreeSet<String> ids = new TreeSet<>();
                sliceVisit(r, reqById, ids);
                slices.add(slice("requirement", r.get("id").getAsString(), ids));
            }
            // A template: itself and what its own attributes reference.
            for (JsonObject n : nodes) {
                if (!TemplateConstants.TYPE_TEMPLATE.equals(n.get("type").getAsString())) continue;
                TreeSet<String> ids = new TreeSet<>();
                ids.add(n.get("id").getAsString());
                for (JsonElement el : n.getAsJsonArray("refs")) {
                    JsonObject r = el.getAsJsonObject();
                    if (!r.get("via").isJsonNull()) continue;
                    String tid = r.getAsJsonObject("target").get("id").getAsString();
                    Walked w = byId.get(tid);
                    ids.add(w != null ? w.top.id : tid);
                }
                slices.add(slice("prompt", n.get("id").getAsString(), ids));
            }
            slices.sort((a, c) -> a.get("id").getAsString().compareTo(c.get("id").getAsString()));
            return array(slices);
        }

        private void sliceVisit(JsonObject x, Map<String, JsonObject> reqById, Set<String> ids) {
            ids.add(x.get("id").getAsString());
            for (JsonElement el : x.getAsJsonArray("implementedBy")) {
                JsonObject l = el.getAsJsonObject();
                if (!l.get("resolves").getAsBoolean()) continue;
                String tid = l.getAsJsonObject("target").get("id").getAsString();
                ids.add(tid);
                Walked w = byId.get(tid);
                if (w != null) ids.add(w.top.id);
            }
            for (JsonElement c : x.getAsJsonArray("children")) {
                JsonObject child = reqById.get(c.getAsJsonObject().get("id").getAsString());
                if (child != null) sliceVisit(child, reqById, ids);
            }
        }

        private static JsonObject slice(String kind, String anchor, Set<String> ids) {
            JsonObject s = new JsonObject();
            s.addProperty("id", kind + ":" + anchor);
            s.addProperty("kind", kind);
            s.addProperty("anchor", anchor);
            s.add("nodes", strings(new ArrayList<>(ids)));
            return s;
        }

        private Walked reqParent(Walked r) {
            return r.parent == null ? null : r.parent.requirement;
        }

        private void subtree(Walked r, Map<Walked, List<Walked>> reqChildren, List<Walked> out) {
            out.add(r);
            for (Walked c : reqChildren.getOrDefault(r, List.of())) subtree(c, reqChildren, out);
        }

        private void below(Walked w, Map<Walked, List<JsonObject>> refsFrom, List<JsonObject> all) {
            for (Walked c : w.children) {
                all.addAll(refsFrom.getOrDefault(c, List.of()));
                below(c, refsFrom, all);
            }
        }

        private List<JsonObject> memberList(List<Walked> ws, Map<Walked, List<JsonObject>> claimsOn,
                                            Map<Walked, List<JsonObject>> refsFrom) {
            List<JsonObject> out = new ArrayList<>();
            for (Walked w : ws) out.add(member(w, claimsOn, refsFrom));
            return out;
        }

        private JsonObject member(Walked w, Map<Walked, List<JsonObject>> claimsOn, Map<Walked, List<JsonObject>> refsFrom) {
            AttrsResult ar = attrsOf(w.md);
            JsonElement ext = extendsLink(w.md);
            List<JsonObject> own = new ArrayList<>();
            if (ext.isJsonObject() && !ext.getAsJsonObject().get("unresolved").getAsBoolean()) {
                own.add(ref(EXTENDS, link(w), ext.getAsJsonObject()));
            }
            for (Map.Entry<String, JsonObject> r : ar.refs) own.add(ref(r.getKey(), link(w), r.getValue()));
            refsFrom.put(w, own);
            JsonObject m = new JsonObject();
            m.addProperty("id", w.id);
            m.addProperty("name", nameOf(w.md));
            m.addProperty("type", w.md.getType());
            m.addProperty("subType", w.md.getSubType());
            m.addProperty("order", w.order);
            m.addProperty("anchor", w.anchor);
            m.addProperty("path", w.path);
            m.addProperty("abstract", isAbstract(w.md));
            m.addProperty("isArray", w.md instanceof MetaField && ((MetaField<?>) w.md).isArrayType());
            m.add("extends", ext);
            m.add("declaredOn", w.declaredOn != null ? linkTo(w.declaredOn, nameOf(w.declaredOn)) : JsonNull.INSTANCE);
            m.add("attrs", ar.attrs);
            m.add("refs", array(own));
            m.add("claims", array(claimsOn.getOrDefault(w, List.of())));
            m.add("memberGroups", groupMembers(memberList(w.children, claimsOn, refsFrom)));
            return m;
        }

        private JsonElement extendsLink(MetaData md) {
            MetaData sup = md.hasSuperData() ? md.getSuperData() : null;
            String superRef = md.getAuthoredSuperRef();
            if (sup == null && superRef == null) return JsonNull.INSTANCE;
            return linkTo(sup, superRef == null ? "" : superRef);
        }

        private record AttrsResult(JsonArray attrs, List<Map.Entry<String, JsonObject>> refs) {}

        /** A node's effective attributes, by name, each value linked where the loader resolved it. */
        private AttrsResult attrsOf(MetaData md) {
            JsonArray attrs = new JsonArray();
            List<Map.Entry<String, JsonObject>> refs = new ArrayList<>();
            TreeMap<String, MetaAttribute> byName = new TreeMap<>();
            for (MetaAttribute a : effectiveAttrs(md)) byName.putIfAbsent(a.getName(), a);
            for (Map.Entry<String, MetaAttribute> e : byName.entrySet()) {
                String name = e.getKey();
                JsonElement value = canonicalValue(CanonicalJsonSerializer.attrValueToJson(e.getValue()));
                boolean isRef = References.isRefBearingAttr(md, name);
                Object resolved = isRef ? declaringResolvedTarget(md, name) : null;
                JsonArray values = new JsonArray();
                if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
                    String text = value.getAsString();
                    JsonElement link = isRef ? refLink(resolved instanceof MetaData ? (MetaData) resolved : null, text) : JsonNull.INSTANCE;
                    values.add(attrValue(text, link));
                    if (link.isJsonObject() && !link.getAsJsonObject().get("unresolved").getAsBoolean()) refs.add(Map.entry(name, link.getAsJsonObject()));
                } else if (value.isJsonArray() && allStrings(value.getAsJsonArray())) {
                    JsonArray arr = value.getAsJsonArray();
                    for (int i = 0; i < arr.size(); i++) {
                        String item = arr.get(i).getAsString();
                        MetaData owner = null;
                        if (resolved instanceof List<?> list && i < list.size() && list.get(i) instanceof MetaData md2) owner = md2;
                        JsonElement link = isRef ? refLink(owner, item) : JsonNull.INSTANCE;
                        values.add(attrValue(item, link));
                        if (link.isJsonObject() && !link.getAsJsonObject().get("unresolved").getAsBoolean()) refs.add(Map.entry(name, link.getAsJsonObject()));
                    }
                } else {
                    values.add(attrValue(DocsViewJson.compact(value), JsonNull.INSTANCE));
                }
                JsonObject a = new JsonObject();
                a.addProperty("name", name);
                a.add("value", value);
                a.add("values", values);
                attrs.add(a);
            }
            return new AttrsResult(attrs, refs);
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /** The node's effective structural children (attributes excluded), in TypeScript's order. */
    private static List<MetaData> children(MetaData md) {
        return CanonicalJsonSerializer.collectEffectiveStructuralChildren(md);
    }

    /**
     * The node's effective attributes: own plus inherited through {@code extends}, own winning.
     * {@code isAbstract} and {@code isArray} are native flags in the view (as in TypeScript), so
     * they are not attributes here.
     */
    private static List<MetaAttribute> effectiveAttrs(MetaData md) {
        List<MetaAttribute> out = new ArrayList<>();
        for (MetaAttribute a : md.getMetaAttrs(true)) {
            String n = a.getName();
            if (MetaData.ATTR_IS_ABSTRACT.equals(n) || MetaField.ATTR_IS_ARRAY.equals(n)) continue;
            out.add(a);
        }
        return out;
    }

    /** What the loader bound for {@code name} on the layer that declares it (own, else the
     *  nearest {@code extends} ancestor). */
    private static Object declaringResolvedTarget(MetaData md, String name) {
        Set<MetaData> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (MetaData n = md; n != null && seen.add(n); n = n.hasSuperData() ? n.getSuperData() : null) {
            // ADR-0039: own — locating the layer that declares the attr, walking the super chain.
            if (n.hasMetaAttr(name, false)) return n.getMetaAttr(name, false).getResolvedTarget();
        }
        return null;
    }

    /** The name as the view states it: {@code ""} for one the parser generated. */
    private static String nameOf(MetaData md) {
        if (CanonicalJsonSerializer.isAutoGeneratedName(md)) return "";
        String s = md.getShortName();
        return s == null ? "" : s;
    }

    private static String plainOf(MetaData md) {
        String pkg = References.effectivePackageOf(md);
        return pkg.isEmpty() ? nameOf(md) : pkg + PKG + nameOf(md);
    }

    private static boolean isAbstract(MetaData md) {
        // ADR-0039: own — @isAbstract is a declaration-layer marker, never inherited.
        return md.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)
            && Boolean.TRUE.equals(md.getMetaAttr(MetaData.ATTR_IS_ABSTRACT, false).getValue());
    }

    private static String strAttr(MetaData md, String name) {
        if (!md.hasMetaAttr(name)) return "";
        Object v = md.getMetaAttr(name).getValue();
        return v instanceof String s ? s : "";
    }

    private static String qualified(String id, MetaData md) {
        return id + "[" + md.getType() + TYPE_SUB + md.getSubType() + "]";
    }

    /** {@code m-<name>} for a field, {@code m-<type>-<name>} for anything else, {@code m-<type>-<order>} with no name. */
    private static String memberAnchor(MetaData md, String name, int order) {
        if (name.isEmpty()) return "m-" + md.getType() + "-" + order;
        return MetaField.TYPE_FIELD.equals(md.getType()) ? "m-" + name : "m-" + md.getType() + "-" + name;
    }

    /** A member's id after its top-level node's. */
    private static String memberPath(Walked w) {
        String rest = w.id.substring(w.top.id.length());
        return rest.startsWith(DOT) ? rest.substring(DOT.length()) : rest;
    }

    private static String packageDir(String pkg) {
        return pkg.isEmpty() ? "-root" : String.join("/", pkg.split(PKG, -1));
    }

    private static String pageStem(String name) {
        return name.toLowerCase(java.util.Locale.ROOT).equals("index") ? name + ".node" : name;
    }

    private static JsonObject unresolved(String text) {
        JsonObject o = new JsonObject();
        o.addProperty("label", text);
        o.addProperty("id", "");
        o.addProperty("path", "");
        o.addProperty("kind", "");
        o.addProperty("unresolved", true);
        return o;
    }

    private static JsonObject reqLink(String ref, boolean resolves, JsonObject target) {
        JsonObject o = new JsonObject();
        o.addProperty("ref", ref);
        o.addProperty("resolves", resolves);
        o.add("target", target);
        return o;
    }

    private static JsonObject ref(String attr, JsonElement via, JsonObject target) {
        JsonObject o = new JsonObject();
        o.addProperty("attr", attr);
        o.add("via", via);
        o.add("target", target);
        return o;
    }

    private static JsonObject attrValue(String text, JsonElement link) {
        JsonObject o = new JsonObject();
        o.addProperty("text", text);
        o.add("link", link);
        return o;
    }

    private static JsonArray groupMembers(List<JsonObject> members) {
        LinkedHashMap<String, JsonObject> groups = new LinkedHashMap<>();
        for (JsonObject m : members) {
            JsonObject g = groups.computeIfAbsent(m.get("type").getAsString(), t -> {
                JsonObject x = new JsonObject();
                x.addProperty("type", t);
                x.addProperty("count", 0);
                x.add("members", new JsonArray());
                return x;
            });
            g.addProperty("count", g.get("count").getAsInt() + 1);
            g.getAsJsonArray("members").add(m);
        }
        return array(new ArrayList<>(groups.values()));
    }

    private static JsonArray statusCounts(List<String> statuses) {
        JsonArray out = new JsonArray();
        for (String status : MetaRequirement.STATUSES) {
            int count = 0;
            for (String s : statuses) if (s.equals(status)) count++;
            JsonObject o = new JsonObject();
            o.addProperty("status", status);
            o.addProperty("count", count);
            out.add(o);
        }
        return out;
    }

    private static Map<String, Deque<Ledger>> ledgerRows(JsonElement verify) {
        if (verify == null || !verify.isJsonObject()) return null;
        JsonElement led = verify.getAsJsonObject().get("requirementLedger");
        if (led == null || !led.isJsonArray()) return null;
        Map<String, Deque<Ledger>> out = new HashMap<>();
        for (JsonElement el : led.getAsJsonArray()) {
            if (!el.isJsonObject()) continue;
            JsonObject raw = el.getAsJsonObject();
            String qp = stringOrNull(raw, "qualifiedPath");
            if (qp == null) continue;
            JsonArray diags = new JsonArray();
            JsonElement ds = raw.get("diagnostics");
            if (ds != null && ds.isJsonArray()) {
                for (JsonElement d : ds.getAsJsonArray()) {
                    if (!d.isJsonObject()) continue;
                    JsonObject dobj = d.getAsJsonObject();
                    JsonObject o = new JsonObject();
                    for (String k : List.of("code", "severity", "source", "message")) o.addProperty(k, str(stringOrNull(dobj, k)));
                    diags.add(o);
                }
            }
            JsonElement supEl = raw.get("supersededBy");
            boolean hasSup = supEl != null && supEl.isJsonObject() && stringOrNull(supEl.getAsJsonObject(), "ref") != null;
            JsonObject sup = hasSup ? supEl.getAsJsonObject() : new JsonObject();
            JsonElement res = sup.get("resolves");
            Ledger row = new Ledger(qp, str(stringOrNull(raw, "digest")), str(stringOrNull(raw, "verdict")), diags,
                str(stringOrNull(sup, "ref")),
                res != null && res.isJsonPrimitive() && res.getAsJsonPrimitive().isBoolean() && res.getAsBoolean(),
                str(stringOrNull(sup, "target")), hasSup);
            out.computeIfAbsent(qp, k -> new ArrayDeque<>()).add(row);
        }
        return out;
    }

    /** A value with every object's keys in code-unit order, as the canonical serializer writes them. */
    private static JsonElement canonicalValue(JsonElement v) {
        if (v == null || v.isJsonNull()) return JsonNull.INSTANCE;
        if (v.isJsonArray()) {
            JsonArray out = new JsonArray();
            for (JsonElement e : v.getAsJsonArray()) out.add(canonicalValue(e));
            return out;
        }
        if (v.isJsonObject()) {
            JsonObject out = new JsonObject();
            for (Map.Entry<String, JsonElement> e : new TreeMap<>(v.getAsJsonObject().asMap()).entrySet()) {
                out.add(e.getKey(), canonicalValue(e.getValue()));
            }
            return out;
        }
        return v;
    }

    private static boolean allStrings(JsonArray arr) {
        for (JsonElement e : arr) if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) return false;
        return true;
    }

    private static String stringOrNull(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString() ? e.getAsString() : null;
    }

    private static boolean isNumber(JsonObject o, String key) {
        if (o == null) return false;
        JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber();
    }

    private static JsonElement num(JsonObject o, String key) {
        return isNumber(o, key) ? o.get(key) : new JsonPrimitive(0);
    }

    private static String str(String s) {
        return s == null ? "" : s;
    }

    private static JsonArray strings(List<String> items) {
        JsonArray out = new JsonArray();
        for (String s : items) out.add(s);
        return out;
    }

    private static JsonArray array(List<JsonObject> items) {
        JsonArray out = new JsonArray();
        for (JsonObject o : items) out.add(o);
        return out;
    }
}
