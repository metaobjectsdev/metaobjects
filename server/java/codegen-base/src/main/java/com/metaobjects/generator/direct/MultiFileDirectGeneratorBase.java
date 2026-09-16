package com.metaobjects.generator.direct;

import com.metaobjects.MetaData;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.MetaDataFilters;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.loader.MetaDataLoader;

import java.io.*;
import java.util.Collection;

public abstract class MultiFileDirectGeneratorBase<M extends MetaData> extends DirectGeneratorBase {

    public static String ARG_FINALOUTPUTDIR = "finalOutputDir";

    protected File outDir = null;
    protected File finalOutDir = null;

    @Override
    protected void parseArgs() {
        super.parseArgs();

        outDir = getOutputDir();
        if (hasArg(ARG_FINALOUTPUTDIR)) {
            finalOutDir = getFinalOutputDir();
        } else {
            finalOutDir = outDir;
        }
    }

    @Override
    public void execute( MetaDataLoader loader ) {

        String filename = null;
        OutputStream out = null;
        GeneratorIOWriter<?> writer = null;

        parseArgs();

        try {
            // Create output file
            outDir = getOutputDir();

            Collection<M> metadata = GeneratorUtil.getFilteredMetaData(
                    loader, getFilterClass(), getMetaDataFilters() );

            // Write each File
            for( M md : metadata ) {

                filename = md.getName();

                String path = getSingleOutputFilePath( md );
                filename = path;

                File fp = new File(outDir, path );
                if ( !fp.exists()) fp.mkdirs();

                String fn = getSingleOutputFilename( md );
                File f = new File( fp, fn );
                filename = f.getPath();

                // Buffer the emit, then hand the finished source to the write guard.
                //
                // This streamed straight to a FileOutputStream, which cannot be guarded at
                // all: opening the stream truncates the file, so by the time there is any
                // content to compare, whatever the user had there is already gone. Every
                // per-object .java this port emits — the bulk of its output — was therefore
                // written unconditionally, while own-your-codegen.md promised the opposite.
                // Buffering first is what makes the existing file readable before we decide.
                StringWriter buffer = new StringWriter();
                PrintWriter pw = new PrintWriter(buffer);

                writer = getSingleWriter(loader, md, pw);
                writer.withFilters(MetaDataFilters.create( getFilters() ))
                        .withFilename( fn );

                writeSingleFile( md, writer);
                writer.close();
                writer = null;

                GeneratedFileWriter.write( f.toPath(), buffer.toString() );

                pw = null;
            }

            // Write any final files if specified
            if ( hasArg(ARG_OUTPUTFILENAME)) {

                filename = getOutputFilename();

                // Create output file
                File outf = new File(finalOutDir, getOutputFilename());
                outf.createNewFile();

                // Get the printwriter
                out = new FileOutputStream(outf);

                writer = getFinalWriter(loader, out);
                if ( writer != null ) {

                    writer.withFilters(MetaDataFilters.create(getFilters()))
                            .withFilename(getOutputFilename());

                    writeFinalFile(metadata, writer);
                }
                else {
                    OutputStream out2 = out;
                    out = null;
                    out2.close();
                }
            }
        }
        catch( IOException e ) {
            throw new GeneratorException( "Unable to write to file [" + filename + "]: " + e, e );
        }
        finally {
            if ( writer != null ) {
                try {
                    writer.close();
                } catch (IOException e) {
                    throw new GeneratorException( "Unable to close file [" + filename + "]: " + e, e );
                }
            }
            else if ( out != null ) {
                try {
                    out.close();
                } catch (IOException e) {
                    log.error("Error closing output stream for file [" + filename + "]: " + e, e );
                }
            }
        }
    }

    protected File getFinalOutputDir() {
        return getAndCreateDir( ARG_FINALOUTPUTDIR, getArg(ARG_FINALOUTPUTDIR, true ));
    }

    protected abstract Class<M> getFilterClass();

    protected abstract <T extends GeneratorIOWriter> T getSingleWriter( MetaDataLoader loader, M md, PrintWriter pw ) throws GeneratorIOException;

    protected abstract <T extends GeneratorIOWriter> T getFinalWriter(MetaDataLoader loader, OutputStream out ) throws GeneratorIOException;

    protected abstract void writeSingleFile( M md, GeneratorIOWriter<?> writer ) throws GeneratorIOException;

    protected abstract void writeFinalFile( Collection<M> metadata, GeneratorIOWriter<?>  writer ) throws GeneratorIOException;

    protected abstract String getSingleOutputFilePath( M md );

    protected abstract String getSingleOutputFilename( M md );
}
