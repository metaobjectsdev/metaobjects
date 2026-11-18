package com.metaobjects.generator.util;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.object.MetaObject;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Generated output paths are keyed by the object's METADATA package (GitHub #546): every JVM
 * generator places a per-object file in the directory of {@code pkg::Name} mapped to a Java/Kotlin
 * package ({@code a::b} -&gt; {@code a.b}, and {@code a/b} on disk), so two same-named objects in two
 * packages are two files. This class is the other half: it refuses the run when two DIFFERENT
 * metadata packages would land in ONE directory, where the second would silently overwrite the
 * first (or, with differing content, trip the writer's order-dependent "Output path collision").
 *
 * <p>Two metadata packages share a directory when their mapped names are equal ignoring letter case
 * (a case-insensitive filesystem folds {@code Sales} and {@code sales} into one directory) or when
 * the separator mapping makes them equal ({@code a.b}, a single segment with a dot, and
 * {@code a::b}). Called ONCE, over the whole own object set, before any generator runs, like
 * {@link RouteNaming#assertNoCollectionNameCollisions}. A pure function of the object set.</p>
 *
 * <p>The error code {@value #CODE} matches the TypeScript and C# ports' claim registry.</p>
 */
public final class OutputPackageCollisions {

    /** The code every port's output-path collision refusal carries. */
    public static final String CODE = "ERR_NAME_COLLISION";

    private OutputPackageCollisions() {
    }

    /** The metadata package of {@code fqn} ({@code a::b::Name} -&gt; {@code a::b}); empty when it has none. */
    static String metadataPackageOf(String fqn) {
        int sep = fqn.lastIndexOf("::");
        return sep < 0 ? "" : fqn.substring(0, sep);
    }

    /** The directory key a metadata package generates into: the mapped package, case-folded. */
    static String directoryKey(String metadataPackage) {
        return metadataPackage.replace("::", ".").toLowerCase(Locale.ROOT);
    }

    /**
     * @throws GeneratorException ({@value #CODE}) naming both metadata packages, an object of each,
     *     and the remedy, when two distinct metadata packages share one output directory
     */
    public static void assertDistinct(List<MetaObject> objects) {
        // directory key -> first (metadata package, object) seen for it, in input order.
        Map<String, String[]> owner = new LinkedHashMap<>();
        for (MetaObject obj : objects) {
            String fqn = obj.getName();
            String pkg = metadataPackageOf(fqn);
            String key = directoryKey(pkg);
            String[] first = owner.get(key);
            if (first == null) {
                owner.put(key, new String[] {pkg, fqn});
            } else if (!first[0].equals(pkg)) {
                throw new GeneratorException(CODE + ": the metadata packages \"" + first[0] + "\" (object \""
                    + first[1] + "\") and \"" + pkg + "\" (object \"" + fqn + "\") both generate into the output "
                    + "directory for the package \"" + key.replace('.', '/') + "\", so one would overwrite the "
                    + "other (a case-insensitive filesystem folds letter case, and \"::\" maps to \".\"). "
                    + "Rename one package so the two differ by more than letter case or separators.");
            }
        }
    }
}
