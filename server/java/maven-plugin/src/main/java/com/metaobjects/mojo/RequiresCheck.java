package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorRegistry;
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
 */
final class RequiresCheck {

    private RequiresCheck() {
    }

    /** One registered generator: its port, stable name, class name and what it requires. */
    private record Known(String port, String stableName, String classname, List<String> requires) {
        String simpleName() {
            return classname.substring(classname.lastIndexOf('.') + 1);
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

    /** The registry entry {@code classname} is, or {@code null}: by class name, then by simple name. */
    private static Known resolve(List<Known> known, String classname) {
        for (Known k : known) if (k.classname().equals(classname)) return k;
        String simple = classname.substring(classname.lastIndexOf('.') + 1);
        for (Known k : known) if (k.simpleName().equals(simple)) return k;
        return null;
    }

    /**
     * One line per declared generator whose requirements the same list does not declare, naming
     * what is missing and the class to add; empty when every requirement is met.
     *
     * @param classnames the {@code <classname>} of each {@code <generator>}, in declared order
     */
    static List<String> unmet(List<String> classnames) {
        List<Known> known = known();
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
            List<String> missing = new ArrayList<>();
            for (String r : k.requires()) {
                if (present.contains(k.port() + ":" + r)) continue;
                Known needed = known.stream()
                        .filter(n -> n.port().equals(k.port()) && n.stableName().equals(r))
                        .findFirst().orElse(null);
                missing.add("\"" + r + "\"" + (needed == null ? "" : " (" + needed.classname() + ")"));
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
