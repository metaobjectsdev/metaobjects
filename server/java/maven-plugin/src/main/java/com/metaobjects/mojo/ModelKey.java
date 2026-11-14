package com.metaobjects.mojo;

import com.metaobjects.MetaData;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The model half of the ADR-0062 skip key, taken from the LOADED root and never from the
 * metadata source files.
 *
 * <p>Each root-level node is hashed in its canonical effective form
 * ({@link CanonicalJsonSerializer#canonicalSerializeEffective}: {@code extends} and overlays
 * applied, attributes in fixed order, no source positions), so reformatting a file, reordering
 * it or moving an object to another file leaves the key alone, and editing an abstract parent
 * changes the key of every object that inherits from it. Node hashes roll up into one hash per
 * package (sorted {@code name:hash} lines) and one for the model. The tree is exposed so a later
 * per-object or per-package key can reuse it.
 */
final class ModelKey {

    /** Node hashes by {@code type.subtype name}, package hashes by package, and the model hash. */
    record Tree(Map<String, String> nodes, Map<String, String> packages, String model) {}

    private ModelKey() {}

    static Tree of(MetaDataLoader loader) {
        Map<String, String> nodes = new TreeMap<>();
        Map<String, List<String>> byPackage = new TreeMap<>();
        for (MetaData child : loader.getRoot().getChildren()) {
            String name = child.getName() == null ? "" : child.getName();
            String key = child.getType() + "." + child.getSubType() + " " + name;
            String hash = GenFingerprint.sha256(key + "\n" + CanonicalJsonSerializer.canonicalSerializeEffective(child));
            nodes.put(key, hash);
            String pkg = child.getPackage() == null ? "" : child.getPackage();
            byPackage.computeIfAbsent(pkg, k -> new ArrayList<>()).add(key + ":" + hash);
        }
        Map<String, String> packages = new TreeMap<>();
        List<String> modelLines = new ArrayList<>();
        byPackage.forEach((pkg, lines) -> {
            lines.sort(Comparator.naturalOrder());
            String h = GenFingerprint.sha256(String.join("\n", lines));
            packages.put(pkg, h);
            modelLines.add(pkg + ":" + h);
        });
        return new Tree(nodes, packages, GenFingerprint.sha256(String.join("\n", modelLines)));
    }
}
