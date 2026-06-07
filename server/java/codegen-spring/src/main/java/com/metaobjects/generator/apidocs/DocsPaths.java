package com.metaobjects.generator.apidocs;

/** Doc-page path math, byte-parity with the TS docs-paths.ts contract (SP-1 apiSurfaces).
 *  Cross-links computed here must match what the TS side emits for the same layout. */
public final class DocsPaths {
  public enum Layout { FLAT, PACKAGE }
  private DocsPaths() {}

  /** "acme::shop" or "acme.shop" -> "acme/shop"; null/"" -> "". */
  public static String packageToPath(String pkg) {
    if (pkg == null || pkg.isEmpty()) return "";
    return pkg.replace("::", "/").replace(".", "/");
  }

  /** Flat -> "<name>.md"; Package -> "<pkg-folded>/<name>.md". */
  public static String docPageOutputPath(Layout layout, String pkg, String name) {
    String file = name + ".md";
    if (layout == Layout.FLAT) return file;
    String dir = packageToPath(pkg);
    return dir.isEmpty() ? file : dir + "/" + file;
  }

  /** Relative posix href from fromOutputPath's directory to toOutputPath (mirrors TS surfaceCrossHref). */
  public static String surfaceCrossHref(String fromOutputPath, String toOutputPath) {
    String fromDir = fromOutputPath.contains("/")
        ? fromOutputPath.substring(0, fromOutputPath.lastIndexOf('/')) : "";
    String rel = posixRelative(fromDir, toOutputPath);
    return rel.startsWith(".") ? rel : "./" + rel;
  }

  /** From an api page to its model page: relative by default, absolute when modelBaseUrl is set (federated). */
  public static String modelCrossHref(String apiPagePath, String modelPagePath, String modelBaseUrl) {
    if (modelBaseUrl != null && !modelBaseUrl.isEmpty())
      return modelBaseUrl.replaceAll("/+$", "") + "/" + modelPagePath;
    return surfaceCrossHref(apiPagePath, modelPagePath);
  }

  /** node:path/posix relative(fromDir, toPath): drop common prefix, ".." per remaining fromDir segment,
   *  then remaining toPath segments. "" fromDir -> toPath; identical -> ".". */
  private static String posixRelative(String fromDir, String toPath) {
    if (fromDir.isEmpty()) return toPath;
    String[] from = fromDir.split("/");
    String[] to = toPath.split("/");
    int common = 0, max = Math.min(from.length, to.length);
    while (common < max && from[common].equals(to[common])) common++;
    StringBuilder rel = new StringBuilder();
    for (int i = common; i < from.length; i++) { if (rel.length() > 0) rel.append('/'); rel.append(".."); }
    for (int i = common; i < to.length; i++) { if (rel.length() > 0) rel.append('/'); rel.append(to[i]); }
    return rel.length() == 0 ? "." : rel.toString();
  }
}
