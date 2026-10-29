package com.metaobjects.generator.util;

import com.metaobjects.MetaData;
import com.metaobjects.generator.MetaDataFilters;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class GeneratorUtil {

    public static Collection<MetaData> getFilteredMetaData(MetaDataLoader loader, MetaDataFilters filters ) {
        List<MetaData> own = new ArrayList<>();
        for (MetaData md : loader.getChildren()) {
            if (!isImported(md)) own.add(md);
        }
        return filterMetaData( own, MetaData.class, filters );
    }

    /**
     * FR-023 — true for an object a metadata DEPENDENCY owns: its package is one the project's
     * dependency snapshot exports and {@code scope.include} does not name. Such an object stays in
     * the loaded model (the project's own nodes {@code extends} and reference it), but it is
     * another project's to generate: a generator emits nothing for it, exactly as the TypeScript
     * and Python selection points do. False for anything that is not an object, and for every tree
     * loaded without dependencies.
     */
    public static boolean isImported(MetaData md) {
        if (!(md instanceof MetaObject)) return false;
        MetaDataLoader loader = md.getLoader();
        if (loader == null) return false;
        com.metaobjects.config.DependencySet deps = loader.getRoot().getDependencySet();
        return !deps.isEmpty() && !deps.inScope(md.getName());
    }

    /** {@code loader.getMetaObjects()} without the objects a dependency owns ({@link #isImported}). */
    public static List<MetaObject> ownMetaObjects(MetaDataLoader loader) {
        List<MetaObject> out = new ArrayList<>();
        for (MetaObject mo : loader.getMetaObjects()) {
            if (!isImported(mo)) out.add(mo);
        }
        return out;
    }

    public static <T extends MetaData> Collection<T> getFilteredMetaData(MetaDataLoader loader, Class<T> clazz, MetaDataFilters filters ) {
        // FR-044: no generator that selects its objects here emits for an object.report, with
        // or without a view source. Dropped here because every direct per-object generator
        // (the Java model tier, the Mustache and PlantUML generators) selects its objects
        // through this overload.
        List<T> generatable = new ArrayList<>();
        for (T md : loader.getMetaData( clazz )) {
            if (!isReport(md) && !isImported(md)) generatable.add(md);
        }
        return filterMetaData( generatable, clazz, filters );
    }

    /**
     * True for an {@code object.report} (FR-044): the declared node or its read model.
     * The model-tier generators that ask this skip a report outright; a report that
     * declares a read-only {@code source.rdb @kind: view} would otherwise pass every
     * source-keyed gate. The REST-surface generators do not ask this to decide: they map
     * each object through {@link RestSurfaceGate#restShapeOf}, which serves a view-backed
     * report from its read model and drops every other report (Plan 3). The Kotlin Exposed
     * table generator emits the read-only table object of a view-backed report.
     */
    public static boolean isReport(MetaData md) {
        return md instanceof MetaObject && MetaObject.SUBTYPE_REPORT.equals(md.getSubType());
    }

    private static <T extends MetaData> Collection<T> filterMetaData( Collection<T> in, Class<T> clazz, MetaDataFilters filtersIn ) {

        List<T> out = new ArrayList<>();

        List<String> filters = filtersIn==null?null:filtersIn.getFilters();

        if ( filters == null || filters.isEmpty() ) {
            out.addAll(in);
        }
        else {
            List<String> incFilters = filters.stream()
                    .filter( f -> !f.startsWith("!"))
                    .collect(Collectors.toList());
            List<String> excFilters = filters.stream()
                    .filter( f -> f.startsWith("!"))
                    .collect(Collectors.toList());

            for (T md : in) {

                boolean shouldAdd = incFilters.isEmpty();

                // Check inclusive filters
                for (String f : incFilters) {
                    if ( filterMatch(md, f)) {
                        shouldAdd = true;
                        break;
                    }
                }

                // Check inclusive filters
                for (String f : excFilters) {
                    if ( filterMatch(md, f.substring(1))) {
                        shouldAdd = false;
                        break;
                    }
                }

                if (shouldAdd) out.add(md);
            }
        }

        return out;
    }

    public static boolean filterMatch(MetaData md, String filter ) {

        String f = filter;
        int i = filter.indexOf( ".[");
        if ( i > 0 ) f = filter.substring( 0, i );

        boolean match = filterByName(md.getName(), f);

        if ( match && i > 0 ) match = filterByMetaData( md, filter.substring( i+1 ).trim());

        return match;
    }

    public static boolean filterByMetaData(MetaData md, String metaDataFilter) {
        if (metaDataFilter == null || metaDataFilter.trim().isEmpty()) {
            return false;
        }

        try {
            String [] v1 = metaDataFilter.split( "=");
            if ( v1.length > 0 ) {

                String[] attrs = v1[0].split(":");
                if ( attrs.length == 2 && attrs[0].equals("[attr")) {

                    String attrName = attrs[1];
                    if (attrName.length() < 2 || !attrName.endsWith("]")) {
                        return false; // Malformed attribute syntax
                    }
                    
                    String an = attrName.substring( 0, attrName.length()-1);
                    if ( md.hasMetaAttr( an ) ) {
                        if (v1.length > 1) {
                            String[] vals = v1[1].split("\"");
                            if ( vals.length > 0 ) {
                                return vals[0].equals( md.getMetaAttr(an).getValueAsString() );
                            }
                        }
                        else {
                            return true;
                        }
                    }
                }
            }
        } catch (Exception e) {
            // Return false for any malformed filter syntax
            return false;
        }

        return false;
    }

    public static boolean filterByName( String metaDataName, String nameFilter) {
        return Pattern.compile(createRegexFromGlob(nameFilter)).matcher( metaDataName ).matches();
    }

    /**
     * Glob to regex for the {@code <filters>} name surface: {@code *} any run (crossing {@code ::}),
     * {@code @} one segment, {@code ?} one character. Every other character is literal, quoted so
     * regex metacharacters in a name (e.g. {@code a::B(}) cannot throw or change the match.
     * Deliberately not {@code Scope.compilePattern}: that grammar's {@code *} never crosses {@code ::}.
     */
    private static String createRegexFromGlob(String glob)
    {
        StringBuilder out = new StringBuilder("^");
        StringBuilder literal = new StringBuilder();
        for(int i = 0; i < glob.length(); ++i)
        {
            final char c = glob.charAt(i);
            String wildcard = switch(c) {
                case '*' -> ".*";
                case '@' -> "[^:]+";
                case '?' -> ".";
                default -> null;
            };
            if (wildcard == null) { literal.append(c); continue; }
            if (literal.length() > 0) { out.append(Pattern.quote(literal.toString())); literal.setLength(0); }
            out.append(wildcard);
        }
        if (literal.length() > 0) out.append(Pattern.quote(literal.toString()));
        return out.append('$').toString();
    }

    public static String toRelativePackage( String p1, String p2 ) {

        if (p1.isEmpty() && p2.isEmpty() ) {
            return "";
        }

        if ( p2.isEmpty() ) return "";
        if ( p1.isEmpty() ) return p2 + "::";

        String [] p1s = p1.split("::");
        String [] p2s = p2.split("::");

        if ( !p1s[0].equals(p2s[0])) return p2 + "::";

        int max = p1s.length;
        if ( p2s.length < p1s.length ) max = p2s.length;

        int n = 0;
        while( max > n && p1s[n].equals(p2s[n])) {
            n++;
        }

        StringBuilder out = new StringBuilder();

        if ( p2s.length < p1s.length ) {
            out.append("...::");
        }
        else if (n==max) {
            out.append("::");
        }
        else {
            for (int i = n; i < max; i++) {
                out.append("..::");
            }
        }

        for (int i = n; i < p2s.length; i++ ) {
            out.append( p2s[i] +"::");
        }

        //out.append( "::");

        return out.toString();
    }

    public static String toCamelCase( String text, boolean capitalizeFirstChar ) {

        if (text == null || text.isEmpty()) {
            return text;
        }

        StringBuilder converted = new StringBuilder();

        boolean first = true;
        boolean convertNext = false;
        for (char ch : text.toCharArray()) {
            if (ch == '-') {
                convertNext = true;
            }
            else if (convertNext) {
                ch = Character.toTitleCase(ch);
                convertNext = false;
                converted.append(ch);
            }
            else if (first && capitalizeFirstChar) {
                ch = Character.toTitleCase(ch);
                converted.append(ch);
            }
            else {
                converted.append(ch);
            }
            if ( first ) first = false;
        }

        return converted.toString();
    }

    public static List<String> getUniquePackages(Collection<? extends MetaData> filtered ) throws IOException {
        List<String> pkgs = new ArrayList<>();

        filtered.forEach( md -> {
            if ( md instanceof MetaObject
                    && !pkgs.contains( md.getPackage() )) {
                pkgs.add( md.getPackage() );
            }
        });

        return pkgs;
    }

    public static boolean isAbstract( MetaData md ) {
        // Own-only read (do not walk the super-chain): matches the canonical
        // abstract contract in ValidationPhase + CanonicalJsonSerializer, so a
        // concrete entity extending an abstract base is NOT reported abstract.
        if ( md.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)
                && Boolean.TRUE.equals( md.getMetaAttr( MetaData.ATTR_IS_ABSTRACT, false ).getValue())) {
            return true;
        }
        return false;
    }
}
