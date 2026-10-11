package com.metaobjects.generator.spring;

import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.GeneratorRegistry.GeneratorInfo;
import org.junit.Test;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * An owned generator must run owned emit rules only.
 *
 * <p>{@code mvn metaobjects:eject} copies a generator and the support class it imports
 * ({@link GeneratorRegistry#EJECT_SUPPORT}) into the adopter's package. Everything else the
 * copies call stays packaged. If one of those packaged classes called back into the packaged
 * support class, an owned generator would still run the packaged rule through it: the
 * adopter edits which fields a DTO carries, and a packaged helper keeps selecting the
 * reference set. Likewise an ejectable generator that called another ejectable generator
 * would, as a copy, keep calling the packaged one.
 *
 * <p>Both are read from the compiled classes of this module, the dependency graph the JVM
 * links, so a comment or a javadoc link is not a reference and an unimported call is. The
 * starting points come from the registry, never a hand-typed list.
 */
public class OwnedPathNeverReachesPackagedSupportTest {

    private final Path classes = classesDir();
    private final Map<String, Set<String>> refsByClass = new HashMap<>();

    private static Path classesDir() {
        try {
            Path dir = Path.of(GeneratorRegistry.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            assertTrue("expected this module's compiled classes as a directory: " + dir, Files.isDirectory(dir));
            return dir;
        } catch (java.net.URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Set<String> support() {
        Set<String> out = new TreeSet<>();
        for (String simple : GeneratorRegistry.EJECT_SUPPORT) out.add(GeneratorRegistry.SUPPORT_PACKAGE + "." + simple);
        return out;
    }

    /** Every ejectable generator in this module (an ejectable generator of another module,
     *  if one is ever registered, has no class file here and is not this test's to read). */
    private Set<String> ejectableGenerators() {
        Set<String> out = new TreeSet<>();
        for (GeneratorInfo info : GeneratorRegistry.list().values()) {
            if (info.ejectResourcePath() != null && Files.exists(classFile(info.classname()))) {
                out.add(info.classname());
            }
        }
        return out;
    }

    @Test
    public void noPackagedClassAnOwnedGeneratorReachesRefersBackToTheSupportClass() throws IOException {
        Set<String> support = support();
        Set<String> owned = new TreeSet<>(support);
        owned.addAll(ejectableGenerators());

        Deque<String> queue = new ArrayDeque<>(owned);
        Set<String> seen = new HashSet<>(owned);
        List<String> backEdges = new ArrayList<>();
        int packagedReached = 0;
        boolean anOwnedGeneratorUsesSupport = false;
        while (!queue.isEmpty()) {
            String cls = queue.poll();
            boolean isOwned = owned.contains(outer(cls));
            boolean refersToSupport = false;
            for (String ref : refs(cls)) {
                if (support.contains(outer(ref))) refersToSupport = true;
                if (seen.add(ref) && Files.exists(classFile(ref))) queue.add(ref);
            }
            if (!isOwned) {
                packagedReached++;
                if (refersToSupport) backEdges.add(cls);
            } else if (refersToSupport && !support.contains(outer(cls))) {
                anOwnedGeneratorUsesSupport = true;
            }
        }
        assertTrue("the walk found no generator using the support class, so it proves nothing",
                anOwnedGeneratorUsesSupport);
        assertTrue("the walk reached no packaged class, so it proves nothing", packagedReached > 0);
        assertTrue("packaged classes an owned generator calls still refer to " + support
                + ", so an owned generator runs the packaged rules through them: " + backEdges,
                backEdges.isEmpty());
    }

    @Test
    public void noEjectableGeneratorRefersToAnotherEjectableGenerator() throws IOException {
        Set<String> generators = ejectableGenerators();
        assertFalse("expected the registry to name ejectable generators", generators.isEmpty());
        List<String> offenders = new ArrayList<>();
        for (String generator : generators) {
            Deque<String> queue = new ArrayDeque<>(List.of(generator));
            Set<String> seen = new HashSet<>(queue);
            while (!queue.isEmpty()) {
                for (String ref : refs(queue.poll())) {
                    String refOuter = outer(ref);
                    if (refOuter.equals(generator)) {
                        if (seen.add(ref) && Files.exists(classFile(ref))) queue.add(ref);
                    } else if (generators.contains(refOuter)) {
                        offenders.add(generator + " -> " + refOuter);
                    }
                }
            }
        }
        assertTrue("an owned copy of the first would keep calling the packaged second: " + offenders,
                offenders.isEmpty());
    }

    private static String outer(String className) {
        int dollar = className.indexOf('$');
        return dollar < 0 ? className : className.substring(0, dollar);
    }

    private Path classFile(String className) {
        return classes.resolve(className.replace('.', '/') + ".class");
    }

    /** The classes {@code className} links against: every {@code CONSTANT_Class} entry of its
     *  constant pool (JVMS 4.4), which covers calls, field reads, casts and nested classes. */
    private Set<String> refs(String className) throws IOException {
        Set<String> cached = refsByClass.get(className);
        if (cached != null) return cached;
        Set<String> out = new TreeSet<>();
        try (InputStream raw = Files.newInputStream(classFile(className));
             DataInputStream in = new DataInputStream(raw)) {
            in.readInt();            // magic
            in.readUnsignedShort();  // minor
            in.readUnsignedShort();  // major
            int count = in.readUnsignedShort();
            String[] utf8 = new String[count];
            List<Integer> classNameIndexes = new ArrayList<>();
            for (int i = 1; i < count; i++) {
                int tag = in.readUnsignedByte();
                switch (tag) {
                    case 1 -> utf8[i] = in.readUTF();
                    case 7 -> classNameIndexes.add(in.readUnsignedShort());
                    case 8, 16, 19, 20 -> in.skipBytes(2);
                    case 15 -> in.skipBytes(3);
                    case 3, 4, 9, 10, 11, 12, 17, 18 -> in.skipBytes(4);
                    case 5, 6 -> {
                        in.skipBytes(8);
                        i++;
                    }
                    default -> throw new IOException("unknown constant pool tag " + tag + " in " + className);
                }
            }
            for (int index : classNameIndexes) {
                String name = utf8[index];
                while (name.startsWith("[")) name = name.substring(1);
                if (name.startsWith("L") && name.endsWith(";")) name = name.substring(1, name.length() - 1);
                if (name.length() > 1) out.add(name.replace('/', '.'));
            }
        }
        refsByClass.put(className, out);
        return out;
    }
}
