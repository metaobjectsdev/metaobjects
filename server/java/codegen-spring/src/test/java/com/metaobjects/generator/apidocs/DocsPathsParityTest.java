package com.metaobjects.generator.apidocs;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
public class DocsPathsParityTest {
  @Test public void surfaceCrossHref_matchesTs() {
    assertEquals("./api/Order.md", DocsPaths.surfaceCrossHref("Order.md", "api/Order.md"));
    assertEquals("../Order.md", DocsPaths.surfaceCrossHref("api/Order.md", "Order.md"));
    assertEquals("../../api/acme/sales/Order.md", DocsPaths.surfaceCrossHref("acme/sales/Order.md", "api/acme/sales/Order.md"));
    assertEquals("../../../acme/sales/Order.md", DocsPaths.surfaceCrossHref("api/acme/sales/Order.md", "acme/sales/Order.md"));
  }
  @Test public void docPageOutputPath_foldsPackage() {
    assertEquals("Order.md", DocsPaths.docPageOutputPath(DocsPaths.Layout.FLAT, "acme.shop", "Order"));
    assertEquals("acme/shop/Order.md", DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, "acme.shop", "Order"));
    assertEquals("Order.md", DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, "", "Order"));
    // also accepts metadata-style "::" packages:
    assertEquals("acme/shop/Order.md", DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, "acme::shop", "Order"));
  }
  @Test public void modelCrossHref_relativeOrBaseUrl() {
    // fromDir "api/java/acme/shop" is 4 segments deep; node:path/posix relative()
    // (the TS contract) emits one ".." per fromDir segment -> 4 dots. Byte-parity.
    assertEquals("../../../../acme/shop/Order.md",
        DocsPaths.modelCrossHref("api/java/acme/shop/Order.md", "acme/shop/Order.md", null));
    assertEquals("../Order.md",
        DocsPaths.modelCrossHref("api/Order.md", "Order.md", null));
    assertEquals("https://d/model/acme/shop/Order.md",
        DocsPaths.modelCrossHref("api/java/acme/shop/Order.md", "acme/shop/Order.md", "https://d/model"));
    assertEquals("https://d/model/acme/shop/Order.md",
        DocsPaths.modelCrossHref("api/java/acme/shop/Order.md", "acme/shop/Order.md", "https://d/model/"));
  }
}
