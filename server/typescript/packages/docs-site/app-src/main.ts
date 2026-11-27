// The model explorer as one browser app: every page is drawn when it is visited, by the same page
// code the static export runs (`src/explorer/core.ts`), from the docs view the generator wrote.
//
// It runs from `file://` with no server: the data arrives as classic scripts (`explorer-model.js`
// sets `window.MO_MODEL`, `explorer-stamp.js` sets `window.MO_STAMP`), and routes are hash routes,
// `index.html#/model/acme/shop/Order.html?…#anchor`. A page's own links are rewritten to routes
// as it is drawn, so a link can be opened in a new tab like any other.
//
// It follows the model on disk: once a second it reloads the stamp file, and when the stamp moves
// it reloads the model and draws the page it is on again.
//
// Or it follows a running application: `index.html?source=<url>` names the application's
// `GET {apiPrefix}/_meta/docs` endpoint (docs/features/metadata-api.md), and the app reads the
// docs view from there instead of the model file, once a second, drawing the page again when the
// view changes. The model file, when it loaded, still supplies the title, the prompt texts and
// any owned templates, which a running application's view does not carry.
//
// Built by `scripts/build-app.ts` into `explorer-app/assets/explorer-app.js` at the repository
// root. The bundle also sets `globalThis.MoExplorer`, so a script can render the same pages
// outside a browser (the static export, and the test that holds the bundle to its sources).

import TEMPLATES from "explorer-templates";
import type { DocsView } from "@metaobjectsdev/metadata";
import { createExplorer, type ExplorerCore } from "../src/explorer/core.js";

interface Model {
  stamp: string;
  title: string;
  footer: string;
  texts: Record<string, string>;
  templates: Record<string, string>;
  view: DocsView;
}

interface AppWindow {
  MO_MODEL?: Model;
  MO_STAMP?: string;
  MO_THEME?: () => void;
  MO_EXPLORER?: Record<string, unknown>;
  MO_APP?: unknown;
}

/** Draw the explorer's pages from a model file's contents, outside any browser. */
function explorerFor(model: Model): ExplorerCore {
  return createExplorer({
    view: model.view,
    title: model.title,
    templates: { ...TEMPLATES, ...model.templates },
    texts: model.texts,
    ...(model.footer !== "" && { stamp: model.footer }),
    assetBase: "",
    // The app loads Cytoscape once, in its shell; a drawn page's own script tags are dropped.
    cytoscapeSrc: () => "",
    // Relative to the shell, which every page is drawn into; the map loads it on demand.
    graph3dSrc: () => "assets/3d-force-graph.min.js",
  });
}

(globalThis as Record<string, unknown>).MoExplorer = { explorerFor, templates: TEMPLATES };

if (typeof document !== "undefined") startApp(window as unknown as AppWindow);

function startApp(w: AppWindow): void {
  const BASE = "http://explorer.invalid/";
  const HOME = "index.html";
  let site: ExplorerCore | undefined;
  let loaded = "";
  let current = { path: "", search: "" };
  let leave: (() => void)[] = [];

  const parse = (hash: string): { path: string; search: string; anchor: string } => {
    const raw = hash.replace(/^#\/?/, "");
    const u = new URL(raw === "" ? HOME : raw, BASE);
    let path = u.pathname.slice(1);
    try {
      path = decodeURIComponent(path);
    } catch {
      // A malformed escape is looked up as written.
    }
    return { path: path === "" ? HOME : path, search: u.search, anchor: u.hash.slice(1) };
  };
  const route = (path: string, search: string, anchor = ""): string => `#/${path}${search}${anchor !== "" ? `#${anchor}` : ""}`;

  w.MO_APP = {
    href: (rel: string): string => {
      const r = parse(rel);
      return route(r.path, r.search, r.anchor);
    },
    search: (): string => current.search,
    replaceQuery: (search: string): void => {
      current = { path: current.path, search: search === "?" ? "" : search };
      history.replaceState(null, "", route(current.path, current.search));
    },
    listen: (type: string, f: EventListener): void => {
      document.addEventListener(type, f);
      leave.push(() => document.removeEventListener(type, f));
    },
    onLeave: (f: () => void): void => {
      leave.push(f);
    },
  };

  const build = (model: Model | undefined = w.MO_MODEL): boolean => {
    if (model === undefined) return false;
    site = explorerFor(model);
    w.MO_EXPLORER = site.graphData();
    loaded = model.stamp;
    return true;
  };

  // A running application's endpoint, when the shell was opened with `?source=<url>`.
  const params = new URLSearchParams(location.search);
  const sourceParam = params.get("source");
  let source: URL | undefined;
  let live: { ok: boolean; at: number; error: string } | undefined;
  if (sourceParam !== null && sourceParam !== "") {
    try {
      source = new URL(sourceParam, location.href);
    } catch {
      // Reported by start(): an unusable URL is a source that cannot be read.
    }
  }
  const paintLive = (): void => {
    if (sourceParam === null || sourceParam === "") return;
    const ok = live?.ok ?? false;
    const url = escapeHtml(source?.href ?? sourceParam);
    const html = ok
      ? `<b>●</b> Following the running application at <code>${url}</code>`
      : `<b>●</b> Cannot read <code>${url}</code>${live !== undefined && live.error !== "" ? ` (${escapeHtml(live.error)})` : ""}${site !== undefined ? ", showing the model it last served" : ""}; trying again every second`;
    // Touched only when its text changes, so a page that stays the same stays still.
    let bar = document.getElementById("mo-live");
    if (bar === null) {
      bar = document.createElement("div");
      bar.id = "mo-live";
      document.body.appendChild(bar);
    }
    if (bar.innerHTML !== html) bar.innerHTML = html;
    const cls = ok ? "live-source" : "live-source down";
    if (bar.className !== cls) bar.className = cls;
    if (live !== undefined) bar.dataset.checked = new Date(live.at).toISOString();
    document.documentElement.setAttribute("data-mo-source", ok ? "live" : "down");
  };

  // A drawn page's links are relative to its own path; each becomes a route.
  const rewrite = (root: ParentNode, path: string, search: string): void => {
    for (const a of Array.from(root.querySelectorAll("a[href]"))) {
      const raw = a.getAttribute("href")!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      if (raw.startsWith("#")) {
        a.setAttribute("href", route(path, search, raw.slice(1)));
        continue;
      }
      const u = new URL(raw, BASE + path);
      a.setAttribute("href", route(u.pathname.slice(1), u.search, u.hash.slice(1)));
    }
  };

  const show = (keepScroll: boolean): void => {
    const r = parse(location.hash);
    const draw = site?.pages.get(r.path);
    for (const f of leave) f();
    leave = [];
    current = { path: r.path, search: r.search };
    const html =
      draw !== undefined
        ? draw()
        : `<!doctype html><html><head><title>Not found</title></head><body><main><h1>No such page</h1><p><code>${escapeHtml(r.path)}</code> is not a page of this model.</p><p><a href="${"../".repeat(r.path.split("/").length - 1)}${HOME}">Overview</a></p></main></body></html>`;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script").forEach((s) => s.remove());
    rewrite(doc, r.path, r.search);
    const y = window.scrollY;
    document.title = doc.title;
    for (const a of Array.from(document.body.attributes)) document.body.removeAttribute(a.name);
    for (const a of Array.from(doc.body.attributes)) document.body.setAttribute(a.name, a.value);
    document.body.replaceChildren(...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true)));
    if (draw !== undefined) w.MO_THEME?.();
    if (keepScroll) window.scrollTo(0, y);
    else if (r.anchor !== "") document.getElementById(r.anchor)?.scrollIntoView();
    else window.scrollTo(0, 0);
    document.documentElement.setAttribute("data-mo-route", r.path);
    paintLive();
  };

  window.addEventListener("hashchange", () => {
    const r = parse(location.hash);
    // Only the anchor moved: scroll, do not draw again.
    if (r.path === current.path && r.search === current.search) {
      if (r.anchor !== "") document.getElementById(r.anchor)?.scrollIntoView();
      return;
    }
    show(false);
  });

  // The live view. A script tag (not fetch, which `file://` refuses) reloads the stamp; the model
  // is reloaded only when the stamp moves, and taken only when it carries that stamp, so a model
  // caught half-written is tried again on the next tick.
  const load = (file: string, done: () => void): void => {
    const s = document.createElement("script");
    s.src = `${file}?t=${Date.now()}`;
    s.onload = () => {
      s.remove();
      done();
    };
    s.onerror = () => {
      s.remove();
      done();
    };
    document.head.appendChild(s);
  };
  const poll = (): void => {
    load("explorer-stamp.js", () => {
      if (w.MO_STAMP === undefined || w.MO_STAMP === loaded) return void setTimeout(poll, 1000);
      const want = w.MO_STAMP;
      load("explorer-model.js", () => {
        if (w.MO_MODEL?.stamp === want && build()) show(true);
        setTimeout(poll, 1000);
      });
    });
  };

  // The running application's view replaces the model file's; the file still names the
  // project and carries the prompt texts and owned templates.
  const follow = (url: URL): void => {
    let last = "";
    const tick = async (): Promise<void> => {
      try {
        // `no-cache` revalidates with the ETag the endpoint sends, so an unchanged view costs a
        // 304 on the wire; the body is compared because a cross-origin read may hide the tag.
        const res = await fetch(url.href, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text !== last) {
          const view = JSON.parse(text) as DocsView;
          if (typeof view !== "object" || view === null || !String((view as { format?: unknown }).format).startsWith("metaobjects-docs-view/")) {
            throw new Error("the response is not a docs view");
          }
          const base = w.MO_MODEL;
          const first = site === undefined;
          build({
            stamp: res.headers.get("etag") ?? `${text.length}`,
            title: params.get("title") ?? base?.title ?? url.host,
            footer: base?.footer ?? "",
            texts: base?.texts ?? {},
            templates: base?.templates ?? {},
            view,
          });
          last = text;
          live = { ok: true, at: Date.now(), error: "" };
          show(!first);
        } else {
          live = { ok: true, at: Date.now(), error: "" };
          paintLive();
        }
      } catch (e) {
        live = { ok: false, at: Date.now(), error: e instanceof Error ? e.message : String(e) };
        if (site === undefined) {
          document.body.innerHTML = `<main><h1>No model yet</h1><p>The explorer is waiting for the running application's docs view.</p></main>`;
        }
        paintLive();
      }
      setTimeout(() => void tick(), 1000);
    };
    void tick();
  };

  const start = (): void => {
    if (sourceParam !== null && sourceParam !== "") {
      if (source === undefined) {
        live = { ok: false, at: Date.now(), error: "not a URL" };
        document.body.innerHTML = "<main><h1>No model</h1><p>The <code>source</code> parameter is not a URL.</p></main>";
        paintLive();
        return;
      }
      follow(source);
      return;
    }
    if (!build()) {
      document.body.innerHTML = "<main><h1>No model</h1><p>explorer-model.js did not load. Run <code>meta gen</code> to write it beside this page.</p></main>";
    } else {
      show(false);
    }
    setTimeout(poll, 1000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
