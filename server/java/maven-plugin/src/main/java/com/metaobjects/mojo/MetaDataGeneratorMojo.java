package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.util.*;

@Mojo(name="generate",
        requiresDependencyResolution= ResolutionScope.COMPILE_PLUS_RUNTIME,
        defaultPhase = LifecyclePhase.GENERATE_SOURCES,
        threadSafe = true)   // #233: safe under `mvn -T` once the registry warm-up + per-instance loader key land
public class MetaDataGeneratorMojo extends AbstractMetaDataMojo
{
    @Override
    protected void executeGenerators(MetaDataLoader loader, List<Generator> generatorImpls) {

        // This loop IS the Java port's runner — the one place that spans generators — so it
        // is the only place that can see two of them claiming one output path. TypeScript's
        // runGen and Python's run_gen both refuse that; until this scope existed, Java could
        // not, and a selection whose output depended on generator order produced a WARN and
        // a green build. Opening the run here is what makes the check reach a real build.
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for( Generator gen : generatorImpls ) {
                getLog().info("MetaData Mojo > Executing Generator: " + gen.getClass().getName() );
                run.attributeTo( gen.getClass().getSimpleName() );
                gen.execute( loader );
            }
        }
    }
}
