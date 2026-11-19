// Warm-load driver for the Java loader (the Kotlin facade, metadata-ktx, loads through it).
// usage: java -cp <metaobjects-metadata jar + dependencies> JavaLoad.java <model-dir> <timed-loads>
// Prints one JSON line in the shape the other drivers print.
import com.metaobjects.loader.MetaDataLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public class JavaLoad {
    static void load(Path dir) {
        MetaDataLoader loader = MetaDataLoader.fromDirectory("bench", dir);
        if (!loader.getErrors().isEmpty()) {
            throw new IllegalStateException("load errors: " + loader.getErrors().get(0));
        }
    }

    // Peak resident set from the kernel's own high-water mark, in MiB (Linux).
    static long peakRssMib() throws Exception {
        for (String line : Files.readAllLines(Path.of("/proc/self/status"))) {
            if (line.startsWith("VmHWM:")) {
                return Long.parseLong(line.replaceAll("[^0-9]", "")) / 1024;
            }
        }
        return -1;
    }

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        int n = Integer.parseInt(args.length > 1 ? args[1] : "7");
        load(dir); // warm-up
        List<Double> times = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            long t0 = System.nanoTime();
            load(dir);
            times.add((System.nanoTime() - t0) / 1e6);
        }
        Collections.sort(times);
        System.out.println(String.format(Locale.ROOT,
            "{\"port\":\"java\",\"loads\":%d,\"median_ms\":%.1f,\"peak_rss_mib\":%d}",
            times.size(), times.get(times.size() / 2), peakRssMib()));
    }
}
