package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.kotlin.ConfiguredRequires;
import com.metaobjects.generator.kotlin.GeneratorInfo;
import com.metaobjects.generator.kotlin.GeneratorRegistryKt;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The {@code requires} check {@code mvn metaobjects:generate} makes before it runs a list.
 *
 * <p>A generator's output can reference another generator's output: a Spring controller names
 * {@code <Entity>FilterAllowlist}, {@code <Entity>Dto} and {@code <Entity>Repository}; a Kotlin
 * controller names the Exposed table, the allowlist and the relation queries. A pom that listed
 * the controller without them generated, exited 0, and failed in {@code javac} or
 * {@code kotlinc} on symbols nothing in the build explained. TypeScript, C# and Python print
 * {@code requires} in their catalog; the Maven plugin checked nothing.
 *
 * <p>A {@code <classname>} is matched to its registry entry by its class name, or, for an owned
 * copy {@code mvn metaobjects:eject} wrote, by its simple class name. A generator the registries
 * do not know (the adopter's own) has no requirements, and does not satisfy one. Requirements
 * are per port: a Kotlin controller is not satisfied by a Java DTO generator.
 *
 * <p>A generator that needs less under some args ({@link ConfiguredRequires}: spring-config with
 * {@code validatorEnabled=false} references no validator) is asked for its requirements after
 * its args are set, so the check follows the configuration rather than the default.
 */
final class RequiresCheck {

    private RequiresCheck() {
    }

    /** One registered generator: its port, stable name, class name and what it requires. */
    private record Known(String port, String stableName, String classname, List<String> requires) {
        String simpleName() {
            return EjectSupport.simpleNameOf(classname);
        }
    }

    private static List<Known> known() {
        List<Known> out = new ArrayList<>();
        for (GeneratorRegistry.GeneratorInfo info : GeneratorRegistry.list().values()) {
            out.add(new Known("java", info.stableName(), info.classname(), info.requires()));
        }
        for (Map.Entry<String, GeneratorInfo> e : GeneratorRegistryKt.getGENERATOR_REGISTRY().entrySet()) {
            GeneratorInfo info = e.getValue();
            // The Kotlin registry holds a factory, not a class name; constructing one must not
            // throw (the registry's own contract).
            out.add(new Known("kotlin", info.getName(), info.getFactory().invoke().getClass().getName(),
                    info.getRequires()));
        }
        return out;
    }

    /** The registry id of {@code classname} ({@code <port>:<stable name>}, so an ejected copy
     *  keeps its generator's id), or {@code classname} itself for a generator of your own. */
    static String registryId(String classname) {
        Known k = resolve(known(), classname);
        return k != null ? k.port() + ":" + k.stableName() : classname;
    }

    /** The registry entry {@code classname} is, or {@code null}: by class name, then by simple name. */
    private static Known resolve(List<Known> known, String classname) {
        for (Known k : known) if (k.classname().equals(classname)) return k;
        String simple = EjectSupport.simpleNameOf(classname);
        for (Known k : known) if (k.simpleName().equals(simple)) return k;
        return null;
    }

    /**
     * One line per declared generator whose requirements the same list does not declare, naming
     * everything missing (the requirements of a missing requirement included) and the class to
     * add; empty when every requirement is met. Each generator needs what its registry entry
     * says.
     *
     * @param classnames the {@code <classname>} of each {@code <generator>}, in declared order
     */
    static List<String> unmet(List<String> classnames) {
        return unmet(classnames, Map.of());
    }

    /**
     * As {@link #unmet(List)} for the instances a run is about to execute, args set: a
     * {@link ConfiguredRequires} generator is asked what its configuration needs.
     */
    static List<String> unmetFor(List<Generator> generators) {
        List<String> classnames = new ArrayList<>();
        Map<String, List<String>> configured = new LinkedHashMap<>();
        for (Generator g : generators) {
            String classname = g.getClass().getName();
            classnames.add(classname);
            if (g instanceof ConfiguredRequires c) configured.putIfAbsent(classname, c.configuredRequires());
        }
        return unmet(classnames, configured);
    }

    private static List<String> unmet(List<String> classnames, Map<String, List<String>> configured) {
        List<Known> known = known();
        // One {@code port:stableName} index: membership and the "what class fixes this"
        // lookup read the same structure, so adding a port cannot leave one behind.
        // {@code putIfAbsent} keeps the first entry, as the name lookup did.
        Map<String, Known> byKey = new LinkedHashMap<>();
        for (Known k : known) byKey.putIfAbsent(k.port() + ":" + k.stableName(), k);
        Map<String, Known> declared = new LinkedHashMap<>();
        Set<String> present = new LinkedHashSet<>();
        for (String classname : classnames) {
            Known k = resolve(known, classname);
            if (k == null) continue;
            declared.putIfAbsent(classname, k);
            present.add(k.port() + ":" + k.stableName());
        }
        List<String> lines = new ArrayList<>();
        for (Map.Entry<String, Known> d : declared.entrySet()) {
            Known k = d.getValue();
            // Transitively through what is missing, so one refusal names every companion; a
            // declared requirement's own requirements are reported on its own line.
            List<String> missing = new ArrayList<>();
            Set<String> seen = new LinkedHashSet<>();
            List<String> todo = new ArrayList<>(configured.getOrDefault(d.getKey(), k.requires()));
            while (!todo.isEmpty()) {
                String r = todo.remove(0);
                String key = k.port() + ":" + r;
                if (present.contains(key) || !seen.add(key)) continue;
                Known needed = byKey.get(key);
                missing.add("\"" + r + "\"" + (needed == null ? "" : " (" + needed.classname() + ")"));
                if (needed != null) todo.addAll(needed.requires());
            }
            if (!missing.isEmpty()) {
                lines.add(d.getKey() + " (\"" + k.stableName() + "\") needs " + String.join(", ", missing)
                        + " in the same <generators>: its output references what "
                        + (missing.size() == 1 ? "that generator writes, so without it" : "those generators write, so without them")
                        + " the generated code does not compile.");
            }
        }
        return lines;
    }
}
