package com.metaobjects.generator.template;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Expands the cross-port output-pattern grammar (SP-1 §3.3): {@code {name}},
 * {@code {Name}} (PascalCase), {@code {package}} ({@code ::} → {@code /}). An empty
 * {@code {package}} collapses its trailing/leading slash so {@code {package}/{name}}
 * with no package yields just {@code {name}}. Unknown placeholders are a hard error.
 *
 * <p>Byte-equivalent to the TypeScript {@code output-pattern.ts}.
 */
public final class OutputPattern {

    private OutputPattern() {}

    private static final Pattern TOKEN = Pattern.compile("\\{(\\w+)\\}");

    /**
     * @param pattern the output path pattern
     * @param name    the entity name (may be null for perPackage/perModel scopes)
     * @param pkg     the package (may be null/empty)
     */
    public static String expand(String pattern, String name, String pkg) {
        Matcher m = TOKEN.matcher(pattern);
        StringBuffer sb = new StringBuffer();
        boolean pkgEmpty = false;
        while (m.find()) {
            String token = m.group(1);
            String rep;
            switch (token) {
                case "package": {
                    String p = pkg == null ? "" : pkg.replace("::", "/");
                    if (p.isEmpty()) pkgEmpty = true;
                    rep = p;
                    break;
                }
                case "name":
                    if (name == null) {
                        throw new IllegalArgumentException(
                            "output pattern '" + pattern + "' uses {name} but no entity name is in scope");
                    }
                    rep = name;
                    break;
                case "Name":
                    if (name == null) {
                        throw new IllegalArgumentException(
                            "output pattern '" + pattern + "' uses {Name} but no entity name is in scope");
                    }
                    rep = pascal(name);
                    break;
                default:
                    throw new IllegalArgumentException(
                        "unknown placeholder {" + token + "} in output pattern '" + pattern + "'");
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
        }
        m.appendTail(sb);
        String out = sb.toString();
        if (pkgEmpty) {
            out = out.replaceAll("^/+", "").replaceAll("/{2,}", "/");
        }
        return out;
    }

    private static String pascal(String s) {
        StringBuilder b = new StringBuilder();
        for (String w : s.split("[^A-Za-z0-9]+")) {
            if (w.isEmpty()) continue;
            b.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return b.toString();
    }
}
