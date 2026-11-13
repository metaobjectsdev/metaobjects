/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.api;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.api.Lifecycles.Lifecycle;
import com.metaobjects.config.RulesSettings;
import com.metaobjects.loader.References;
import com.metaobjects.requirement.RequirementCheck.Diagnostic;
import com.metaobjects.requirement.RequirementCheck.Severity;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The business-rules gate ({@code verify}, ADR-0063). The loader refuses a model whose
 * operations or lifecycles are malformed; this gate reports what loads clean but is almost
 * certainly not what the author meant: a state nothing can reach, a lifecycle that cannot move,
 * a transition nothing can make, and (by setting) a permission name the model derived instead
 * of declaring.
 *
 * <p>Java port of the TypeScript reference, {@code rules-check.ts}: the codes, severities,
 * paths and message text are copied from it, and {@code fixtures/rules-check-conformance/}
 * holds this port to it. A model that declares no operation and no transition gets no
 * diagnostics, no summary and no gate row.</p>
 */
public final class RulesCheck {

    private RulesCheck() {}

    public static final String WARN_LIFECYCLE_UNREACHABLE_STATE = "WARN_LIFECYCLE_UNREACHABLE_STATE";
    public static final String WARN_LIFECYCLE_INITIAL_TERMINAL = "WARN_LIFECYCLE_INITIAL_TERMINAL";
    public static final String WARN_TRANSITION_UNREACHABLE = "WARN_TRANSITION_UNREACHABLE";
    public static final String WARN_PERMISSION_DERIVED_NAME = "WARN_PERMISSION_DERIVED_NAME";

    /** What the model declares, for the line {@code verify} prints. */
    public record Summary(int operations, int lifecycles, int transitions) {}

    /** @param summary {@code null} when the model declares no operation and no transition */
    public record Result(List<Diagnostic> diagnostics, Summary summary) {}

    private static String quoteList(Iterable<String> xs) {
        List<String> q = new ArrayList<>();
        for (String x : xs) q.add("\"" + x + "\"");
        return String.join(", ", q);
    }

    /** A node's package-qualified address: {@code acme::shop::Order.status.submit}. */
    public static String rulesAddress(MetaData node) {
        List<String> parts = new ArrayList<>();
        for (MetaData n = node; n != null && n.getParent() != null; n = n.getParent()) {
            String name = n.getShortName();
            if (name != null && !name.isEmpty() && !n.isAutoNamed()) parts.add(0, name);
        }
        String pkg = References.effectivePackageOf(node);
        return pkg.isEmpty() ? String.join(".", parts) : pkg + MetaData.PKG_SEPARATOR + String.join(".", parts);
    }

    /** The permission name a node gets when it declares none: {@code <package>.<name>}. */
    private static String derivedPermissionName(MetaData owner, String name) {
        String pkg = References.effectivePackageOf(owner);
        return pkg.isEmpty() ? name : pkg + "." + name;
    }

    private static boolean needsPermissionName(MetaData node) {
        boolean isPublic = node.hasMetaAttr(ApiConstants.ATTR_PUBLIC)
            && Boolean.TRUE.equals(node.getMetaAttr(ApiConstants.ATTR_PUBLIC).getValue());
        return !node.hasMetaAttr(ApiConstants.ATTR_PERMISSION) && !isPublic;
    }

    private static List<MetaData> entities(MetaRoot root) {
        List<MetaData> out = new ArrayList<>();
        for (MetaData c : root.getChildren(MetaData.class, true)) if (Lifecycles.isEntity(c)) out.add(c);
        return out;
    }

    private static List<MetaData> operations(MetaRoot root) {
        List<MetaData> out = new ArrayList<>();
        for (MetaData api : root.getChildren(MetaData.class, true)) {
            if (!ApiConstants.TYPE_API.equals(api.getType())) continue;
            for (MetaData op : api.getChildren(MetaData.class, true)) {
                if (ApiConstants.TYPE_OPERATION.equals(op.getType())) out.add(op);
            }
        }
        return out;
    }

    /** Every lifecycle of the model, once per declaring field, in model order. */
    private static List<Lifecycle> declaredLifecycles(MetaRoot root) {
        Set<MetaData> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        List<Lifecycle> out = new ArrayList<>();
        for (MetaData entity : entities(root)) {
            for (Lifecycle l : Lifecycles.lifecyclesOf(entity)) {
                if (seen.add(l.field())) out.add(l);
            }
        }
        return out;
    }

    private static void checkLifecycle(Lifecycle l, RulesSettings settings, List<Diagnostic> out) {
        String where = rulesAddress(l.field());
        String initial = l.initial();
        if (initial == null) return; // the loader refused this model (ERR_LIFECYCLE_NO_INITIAL)
        Set<String> reachable = Lifecycles.reachableStates(l);
        Severity severity = switch (settings.lifecycleUnreachable()) {
            case OFF -> null;
            case ERROR -> Severity.ERROR;
            case WARN -> Severity.WARN;
        };
        String field = l.field().getShortName();

        if (severity != null) {
            List<String> unreachable = new ArrayList<>();
            for (String s : l.states()) if (!reachable.contains(s)) unreachable.add(s);
            if (!unreachable.isEmpty()) {
                boolean one = unreachable.size() == 1;
                out.add(new Diagnostic(severity, WARN_LIFECYCLE_UNREACHABLE_STATE, where,
                    (one ? "state " : "states ") + quoteList(unreachable) + " of \"" + field
                        + "\" cannot be reached from the initial state \"" + initial + "\" by any transition. "
                        + "Add the transition that leads there, or set verify.lifecycle.unreachable if only seeded data uses "
                        + (one ? "it" : "them") + "."));
            }
        }

        if (Lifecycles.terminalStates(l).contains(initial)) {
            out.add(new Diagnostic(Severity.WARN, WARN_LIFECYCLE_INITIAL_TERMINAL, where,
                "the initial state \"" + initial + "\" of \"" + field + "\" is terminal: no transition leaves it, "
                    + "so no row of this lifecycle can ever move."));
        }

        if (severity != null) {
            for (MetaData t : l.transitions()) {
                List<String> from = Lifecycles.transitionFrom(t);
                if (from.isEmpty() || from.stream().anyMatch(reachable::contains)) continue;
                out.add(new Diagnostic(severity, WARN_TRANSITION_UNREACHABLE, rulesAddress(t),
                    "transition \"" + t.getShortName() + "\" starts only from " + quoteList(from)
                        + ", which no transition reaches from the initial state \"" + initial
                        + "\", so it can never be made."));
            }
        }
    }

    /** The transition names each declared command claims, per target entity. */
    private static Map<MetaData, Set<String>> claimedTransitions(MetaRoot root) {
        Map<MetaData, Set<String>> claimed = new IdentityHashMap<>();
        for (MetaData op : operations(root)) {
            if (!ApiConstants.OPERATION_SUBTYPE_COMMAND.equals(op.getSubType())) continue;
            MetaData target = Lifecycles.operationTarget(op);
            if (target == null) continue;
            List<String> names = Lifecycles.stringList(op, ApiConstants.ATTR_TRANSITIONS);
            if (names.isEmpty()) continue;
            claimed.computeIfAbsent(target, k -> new HashSet<>()).addAll(names);
        }
        return claimed;
    }

    private static void checkPermissionNames(MetaRoot root, RulesSettings settings, List<Diagnostic> out) {
        if (settings.permissionNames() == RulesSettings.PermissionNames.DERIVE) return;
        Severity severity = settings.permissionNames() == RulesSettings.PermissionNames.REQUIRE ? Severity.ERROR : Severity.WARN;

        if (settings.lifecycleCommands() != RulesSettings.LifecycleCommands.NONE) {
            Map<MetaData, Set<String>> claimed = claimedTransitions(root);
            for (MetaData entity : entities(root)) {
                if (Lifecycles.isAbstract(entity)) continue;
                for (MetaData t : Lifecycles.entityTransitions(entity)) {
                    if (settings.lifecycleCommands() == RulesSettings.LifecycleCommands.UNCLAIMED
                            && claimed.getOrDefault(entity, Set.of()).contains(t.getShortName())) continue;
                    if (!needsPermissionName(t)) continue;
                    out.add(new Diagnostic(severity, WARN_PERMISSION_DERIVED_NAME,
                        rulesAddress(entity) + "." + (t.getParent() == null ? "" : t.getParent().getShortName()) + "." + t.getShortName(),
                        "the command derived from transition \"" + t.getShortName() + "\" of \"" + entity.getShortName()
                            + "\" has no @permission, so it asks the policy about the derived name \""
                            + derivedPermissionName(entity, t.getShortName()) + "\", " + advice("transition")));
                }
            }
        }

        for (MetaData op : operations(root)) {
            if (!needsPermissionName(op)) continue;
            out.add(new Diagnostic(severity, WARN_PERMISSION_DERIVED_NAME, rulesAddress(op),
                "operation." + op.getSubType() + " \"" + op.getShortName() + "\" has no @permission, so it asks the policy about the derived name \""
                    + derivedPermissionName(op, op.getShortName()) + "\", " + advice("operation")));
        }
    }

    private static String advice(String kind) {
        return "which changes if the " + kind + " is renamed. Declare @permission, or @public: true.";
    }

    /** The rules gate over a loaded model. */
    public static Result check(MetaRoot root, RulesSettings settings) {
        List<Lifecycle> lifecycles = declaredLifecycles(root);
        List<MetaData> ops = operations(root);
        if (lifecycles.isEmpty() && ops.isEmpty()) return new Result(new ArrayList<>(), null);

        List<Diagnostic> diagnostics = new ArrayList<>();
        for (Lifecycle l : lifecycles) checkLifecycle(l, settings, diagnostics);
        checkPermissionNames(root, settings, diagnostics);
        int transitions = 0;
        for (Lifecycle l : lifecycles) transitions += l.transitions().size();
        return new Result(diagnostics, new Summary(ops.size(), lifecycles.size(), transitions));
    }
}
