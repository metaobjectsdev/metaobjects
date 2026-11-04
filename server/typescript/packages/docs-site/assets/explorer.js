// The model explorer's scripts: search, the theme toggle, and the three graphs (the model map,
// an object page's one-hop mini-map, the trace). They read window.MO_EXPLORER, which
// assets/explorer-data.js sets from explorer.json; nothing here derives a model fact.
// `meta eject docs-site` copies this file to codegen/docs-site/assets/.
(function () {
  "use strict";
  var D = window.MO_EXPLORER || { nodes: [], edges: [], slices: {}, features: [], reqs: [], generated: {}, search: [] };
  var ROOT = document.body.getAttribute("data-root") || "";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
  var STATUS = ["live", "partial", "planned", "retired"];
  var GLYPH = { live: "●", partial: "◐", planned: "○", retired: "⊘" };
  var PAL = ["#1971c2", "#e8590c", "#2b8a3e", "#ae3ec9", "#c2255c", "#0b7285", "#5c940d", "#f08c00"];
  var byId = {};
  D.nodes.forEach(function (n) { byId[n.id] = n; });
  var reqById = {};
  D.reqs.forEach(function (r) { reqById[r.id] = r; });
  var href = function (rel) { return ROOT + rel; };
  var redraw = [];

  // ── Theme ───────────────────────────────────────────────────────────────
  var themeBtn = $("#theme");
  if (themeBtn) themeBtn.onclick = function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    var next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("mo-theme", next); } catch (e) { /* private window: the toggle still works for this page */ }
    redraw.forEach(function (f) { f(); });
  };

  // ── Search ──────────────────────────────────────────────────────────────
  // The built-in index ships in explorer-data.js and works from file://. When the site has been
  // indexed with Pagefind (`npx pagefind --site <dir>`) and is served over http, Pagefind's
  // full-text index answers instead.
  var q = $("#q"), res = $("#results"), pagefind = null, pagefindTried = false, sel = -1;
  function loadPagefind() {
    if (pagefindTried || !/^https?:$/.test(location.protocol)) return Promise.resolve(null);
    pagefindTried = true;
    var url = new URL(ROOT + "pagefind/pagefind.js", location.href).href;
    return fetch(url, { method: "HEAD" }).then(function (r) {
      if (!r.ok) return null;
      return import(url).then(function (m) { pagefind = m; return m; });
    }).catch(function () { return null; });
  }
  function show(items) {
    sel = -1;
    res.innerHTML = items.length ? items.map(function (x) { return '<a href="' + esc(x.h) + '">' + esc(x.t) + "<small>" + esc(x.s) + "</small></a>"; }).join("") : '<div class="none">No match</div>';
    res.style.display = "block";
  }
  function builtIn(v) {
    var words = v.split(/\s+/).filter(Boolean);
    return D.search.filter(function (x) { return words.every(function (w) { return x.k.indexOf(w) >= 0; }); })
      .sort(function (a, b) { return (a.t.toLowerCase().indexOf(words[0]) === 0 ? 0 : 1) - (b.t.toLowerCase().indexOf(words[0]) === 0 ? 0 : 1); })
      .slice(0, 25).map(function (x) { return { t: x.t, s: x.s, h: href(x.h) }; });
  }
  if (q && res) {
    q.addEventListener("input", function () {
      var v = q.value.trim().toLowerCase();
      if (!v) { res.style.display = "none"; return; }
      show(builtIn(v));
      loadPagefind().then(function (pf) {
        if (!pf || q.value.trim().toLowerCase() !== v) return;
        pf.search(v).then(function (r) {
          return Promise.all(r.results.slice(0, 12).map(function (x) { return x.data(); }));
        }).then(function (rows) {
          if (q.value.trim().toLowerCase() !== v || !rows.length) return;
          show(rows.map(function (d) { return { t: (d.meta && d.meta.title) || d.url, s: (d.excerpt || "").replace(/<[^>]+>/g, ""), h: d.url }; }));
        }).catch(function () { /* keep the built-in results */ });
      });
    });
    q.addEventListener("keydown", function (e) {
      var links = res.querySelectorAll("a");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(0, Math.min(links.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
        links.forEach(function (a, i) { a.classList.toggle("sel", i === sel); });
      } else if (e.key === "Enter" && links.length) {
        location.href = links[Math.max(0, sel)].href;
      } else if (e.key === "Escape") { res.style.display = "none"; q.blur(); }
    });
    document.addEventListener("click", function (e) { if (!$("#search").contains(e.target)) res.style.display = "none"; });
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== q && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
    });
  }

  if (typeof window.cytoscape !== "function") {
    document.querySelectorAll(".graph").forEach(function (g) {
      g.innerHTML = '<div class="note" style="margin:12px">The graph library did not load (it comes from the site\'s <code>assetBase</code>). Every node still has its own page.</div>';
    });
    return;
  }

  // ── Colours ─────────────────────────────────────────────────────────────
  // Fill: the kind, the feature, or the DECLARED status of the claims on a node.
  // Ring: a gate verdict (unclaimed). Never a test result.
  function kindColour(n) {
    return css({ entity: "--entity", value: "--value", prompt: "--prompt", template: "--prompt", projection: "--projection", report: "--report" }[n.kind] || "--entity");
  }
  function fill(n, mode) {
    if (n.abstract) return css("--retired");
    if (mode === "kind") return kindColour(n);
    if (mode === "api") return n.api.length ? css("--accent") : css("--retired-soft");
    if (mode === "claims") return n.claims > 8 ? css("--live") : n.claims > 2 ? css("--partial") : n.claims > 0 ? css("--planned") : css("--retired-soft");
    if (mode === "cap") return n.feature >= 0 ? PAL[n.feature % PAL.length] : n.quality ? css("--retired") : css("--retired-soft");
    return n.status === "unclaimed" ? css("--retired-soft") : css("--" + n.status);
  }
  function legend(mode) {
    var ring = D.hasClaims ? '<span class="chip v-unclaimed">red ring: unclaimed (gate)</span>' : "";
    if (mode === "cap") return '<div class="legend">' + D.features.map(function (f, i) { return '<span class="chip" style="color:' + PAL[i % PAL.length] + '">● ' + esc(f.label) + "</span>"; }).join("") + '<span class="chip" style="color:' + css("--retired") + '">● qualities only</span><span class="chip">○ no claim</span>' + ring + "<span>Fill is the feature (L1) with the most claims on the node; size is fields plus claims.</span></div>";
    if (mode === "status") return '<div class="legend">' + STATUS.map(function (s) { return '<span class="chip s-' + s + '">' + GLYPH[s] + " " + s + "</span>"; }).join("") + '<span class="chip">○ no claim</span>' + ring + "<span>Fill is the best declared status among the requirements that claim the node.</span></div>";
    if (mode === "api") return '<div class="legend"><span class="chip" style="color:' + css("--accent") + '">● mounted routes</span><span class="chip">○ none</span></div>';
    if (mode === "claims") return '<div class="legend"><span class="chip" style="color:' + css("--live") + '">● more than 8 claims</span><span class="chip" style="color:' + css("--partial") + '">● 3 to 8</span><span class="chip" style="color:' + css("--planned") + '">● 1 or 2</span><span class="chip">○ none</span>' + ring + "</div>";
    return '<div class="legend">' + ["entity", "value", "projection", "report", "prompt"].map(function (k) { return '<span class="chip k-' + k + '">● ' + k + "</span>"; }).join("") + "<span>Abstract bases are dashed and grey.</span></div>";
  }
  function shape(n) { return n.kind === "prompt" || n.kind === "template" ? "diamond" : n.kind === "value" ? "round-triangle" : n.kind === "projection" || n.kind === "report" ? "round-hexagon" : n.abstract ? "round-rectangle" : "ellipse"; }
  function baseStyle() {
    return [
      { selector: "node", style: { "background-color": "data(col)", label: "data(label)", width: "data(size)", height: "data(size)", shape: "data(shape)", color: css("--ink"), "font-size": 10, "text-valign": "bottom", "text-margin-y": 3, "border-width": 1, "border-color": css("--line"), "text-wrap": "none" } },
        { selector: "node[dashed = 1]", style: { "border-style": "dashed", "border-width": 2, "background-opacity": 0.4 } },
        { selector: "node[ring = 1]", style: { "border-width": 3, "border-color": css("--bad") } },
        { selector: "node[faded = 1]", style: { opacity: 0.18 } },
        { selector: "edge", style: { width: 1.2, "line-color": css("--muted"), "target-arrow-color": css("--muted"), "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.7, opacity: 0.6 } },
        { selector: "edge[ext = 1]", style: { "line-style": "dashed", "target-arrow-shape": "triangle-tee" } },
        { selector: "edge[faded = 1]", style: { opacity: 0.08 } },
        { selector: ":selected", style: { "border-width": 3, "border-color": css("--accent") } },
    ];
  }
  var bar = function (c) {
    var t = STATUS.reduce(function (a, s) { return a + (c[s] || 0); }, 0);
    if (!t) return '<div class="bar"></div>';
    return '<div class="bar">' + STATUS.filter(function (s) { return c[s]; }).map(function (s) { return '<span class="b-' + s + '" style="width:' + (100 * c[s] / t) + '%"></span>'; }).join("") + "</div>";
  };
  var chip = function (s) { return s ? '<span class="chip s-' + esc(s) + '">' + (GLYPH[s] || "") + " " + esc(s) + "</span>" : ""; };
  var nodeLink = function (id) { var n = byId[id]; return n ? '<a class="k-' + n.kind + '" href="' + esc(href(n.href)) + '">' + esc(n.name) + "</a>" : esc(id); };

  // ── S2: the model map ───────────────────────────────────────────────────
  // cose from a grid (not from one point) gives the same picture on every load.
  var COSE = { name: "cose", animate: false, randomize: false, nodeRepulsion: 12000, nodeOverlap: 24, idealEdgeLength: 90, componentSpacing: 90, gravity: 0.6, padding: 24, nodeDimensionsIncludeLabels: true };
  function seedGrid(els) {
    var nodes = els.filter(function (e) { return !e.data.source; }), cols = Math.ceil(Math.sqrt(nodes.length || 1));
    nodes.forEach(function (e, i) { e.position = { x: (i % cols) * 120, y: Math.floor(i / cols) * 100 }; });
  }
  var cyEl = $("#cy");
  if (cyEl) {
    var cy = null;
    var params = new URLSearchParams(location.search);
    var sliceSel = $("#slice"), colourSel = $("#colour");
    if (params.get("slice") && sliceSel.querySelector('option[value="' + CSS.escape(params.get("slice")) + '"]')) sliceSel.value = params.get("slice");
    if (params.get("colour") && colourSel.querySelector('option[value="' + CSS.escape(params.get("colour")) + '"]')) colourSel.value = params.get("colour");
    var focus = params.get("focus");
    var promptSet = function () {
      var s = {};
      D.nodes.forEach(function (n) { if (n.kind === "prompt" || n.kind === "template") s[n.id] = 1; });
      D.edges.forEach(function (e) { if (s[e.s] && (e.k === "payload" || e.k === "reply")) s[e.t] = 1; });
      D.edges.forEach(function (e) { if (s[e.s] && byId[e.s] && byId[e.s].kind === "value" && e.k === "objectRef") s[e.t] = 1; });
      return s;
    };
    var build = function (relayout) {
      var slice = sliceSel.value, mode = colourSel.value, hide = $("#hideOut").checked, showExt = $("#showExt").checked;
      $("#maplegend").innerHTML = legend(mode);
      var inSlice = null;
      if (slice === "@prompts") inSlice = promptSet();
      else if (slice && D.slices[slice]) { inSlice = {}; D.slices[slice].forEach(function (id) { inSlice[id] = 1; }); }
      var showVals = $("#showValues").checked || slice === "@prompts" || (inSlice && Object.keys(inSlice).some(function (id) { return byId[id] && byId[id].kind !== "entity"; }));
      var entityCount = D.nodes.filter(function (n) { return n.kind === "entity"; }).length;
      if (!entityCount) showVals = true;
      var nodes = D.nodes.filter(function (n) { return (n.kind === "entity" || showVals) && (!hide || !inSlice || inSlice[n.id]); });
      var ids = {};
      nodes.forEach(function (n) { ids[n.id] = 1; });
      var els = nodes.map(function (n) {
        return { data: { id: n.id, label: n.name, col: fill(n, mode), size: 18 + Math.min(40, n.fields * 1.6 + n.claims * 2), shape: shape(n), faded: inSlice && !inSlice[n.id] ? 1 : 0, dashed: n.abstract, ring: n.unclaimed } };
      });
      D.edges.forEach(function (e, i) {
        if (!ids[e.s] || !ids[e.t] || (!showExt && e.k === "extends")) return;
        els.push({ data: { id: "e" + i, source: e.s, target: e.t, label: e.v || e.k, ext: e.k === "extends" ? 1 : 0, faded: inSlice && !(inSlice[e.s] && inSlice[e.t]) ? 1 : 0 } });
      });
      seedGrid(els);
      var pan = cy && !relayout ? { pos: {} } : null;
      if (pan) cy.nodes().forEach(function (n) { pan.pos[n.id()] = n.position(); });
      if (cy) cy.destroy();
      var keep = pan && els.every(function (el) { return el.data.source || pan.pos[el.data.id]; });
      cy = cytoscape({
        container: cyEl, elements: els, wheelSensitivity: 0.3, maxZoom: 1.5, style: baseStyle(),
        layout: keep ? { name: "preset", positions: function (n) { return pan.pos[n.id()]; }, fit: true, padding: 20 } : COSE,
      });
      cy.on("tap", "node", function (ev) { showPanel(ev.target.id()); });
      cy.on("dbltap", "node", function (ev) { var n = byId[ev.target.id()]; if (n) location.href = href(n.href); });
      var sliceReq = slice.indexOf("requirement:") === 0 ? reqById[slice.slice("requirement:".length)] : null;
      if (sliceReq) $("#panel").innerHTML = slicePanel(sliceReq, D.slices[slice] || []);
      if (focus && byId[focus] && cy.getElementById(focus).length) { cy.getElementById(focus).select(); showPanel(focus); focus = null; }
      var u = new URL(location.href);
      if (slice) u.searchParams.set("slice", slice); else u.searchParams.delete("slice");
      u.searchParams.set("colour", mode);
      history.replaceState(null, "", u.search ? u.pathname + u.search : u.pathname);
    };
    ["#slice", "#colour", "#hideOut", "#showValues", "#showExt"].forEach(function (s) { $(s).onchange = function () { build(false); }; });
    $("#relayout").onclick = function () { if (cy) cy.layout(Object.assign({}, COSE, { randomize: true })).run(); };
    redraw.push(function () { build(false); });
    build(true);
  }
  function slicePanel(r, nodes) {
    return '<div class="crumbs">Slice</div><h3 style="margin-top:0"><span class="lvl">' + (r.level ? "L" + r.level : "—") + '</span><a href="' + esc(href(r.href)) + '">' + esc(r.label) + "</a> " + chip(r.status) + "</h3><div>" + esc(r.statement) + "</div>" +
      "<h3>" + r.claimed + " model node" + (r.claimed === 1 ? "" : "s") + " claimed below</h3>" + nodes.map(nodeLink).join(", ") +
      "<h3>Status below</h3>" + bar(r.rollup);
  }
  function showPanel(id) {
    var n = byId[id], p = $("#panel");
    if (!n || !p) return;
    var claims = D.reqs.filter(function (r) { return r.targets.indexOf(id) >= 0; });
    var byTop = {};
    claims.forEach(function (r) { var t = r; while (t.parent && reqById[t.parent]) t = reqById[t.parent]; (byTop[t.id] = byTop[t.id] || []).push(r); });
    var refs = D.edges.filter(function (e) { return e.s === id || e.t === id; }).length;
    var gen = (D.generated[id] || []).map(function (g) { return '<span class="pill">' + esc(g[0]) + "</span> " + g[1]; }).join(" · ");
    p.innerHTML = '<div class="crumbs">' + esc(n.pkg) + " · " + esc(n.kind) + (n.storage ? " · " + esc(n.storage) : "") + "</div>" +
      '<h3 style="margin-top:0">' + nodeLink(id) + (n.unclaimed ? ' <span class="chip v-unclaimed">unclaimed</span>' : "") + "</h3>" +
      "<h3>Why it exists (" + claims.length + " claim" + (claims.length === 1 ? "" : "s") + ")</h3>" +
      (claims.length ? Object.keys(byTop).map(function (t) {
        return "<div><b>" + esc(reqById[t].label) + "</b>: " + byTop[t].slice(0, 6).map(function (r) { return '<a class="g-' + esc(r.status) + '" href="' + esc(href(r.href)) + '">' + (GLYPH[r.status] || "") + " " + esc(r.label) + "</a>"; }).join(", ") + (byTop[t].length > 6 ? " +" + (byTop[t].length - 6) : "") + "</div>";
      }).join("") : '<span class="sub">No requirement claims this node.</span>') +
      "<h3>Shape</h3>" + n.fields + " field" + (n.fields === 1 ? "" : "s") + ", " + refs + " reference" + (refs === 1 ? "" : "s") +
      (n.api.length ? "<h3>API</h3>" + n.api.map(function (a) { return "<div><code>" + esc(a) + "</code></div>"; }).join("") : "") +
      "<h3>Generated</h3>" + (gen || '<span class="sub">nothing traced</span>');
  }

  // ── S3: the one-hop mini-map ────────────────────────────────────────────
  var mini = $("#cymini");
  if (mini) {
    var me = mini.getAttribute("data-node");
    var drawMini = function () {
      var es = D.edges.filter(function (e) { return e.s === me || e.t === me; });
      var ids = {};
      ids[me] = 1;
      es.forEach(function (e) { ids[e.s] = 1; ids[e.t] = 1; });
      var els = Object.keys(ids).filter(function (id) { return byId[id]; }).sort().map(function (id) {
        var n = byId[id];
        return { data: { id: id, label: n.name, col: fill(n, D.hasClaims ? "status" : "kind"), me: id === me ? 1 : 0, ring: n.unclaimed, shape: shape(n) } };
      }).concat(es.map(function (e, i) { return { data: { id: "m" + i, source: e.s, target: e.t, label: e.v || e.k } }; }));
      mini.innerHTML = "";
      var c = cytoscape({
        container: mini, elements: els, maxZoom: 1.3,
        style: [
          { selector: "node", style: { "background-color": "data(col)", label: "data(label)", shape: "data(shape)", "font-size": 10, color: css("--ink"), "text-valign": "bottom", "text-margin-y": 2, width: 18, height: 18, "border-width": 1, "border-color": css("--line") } },
          { selector: "node[ring = 1]", style: { "border-width": 3, "border-color": css("--bad") } },
          { selector: "node[me = 1]", style: { width: 30, height: 30, "border-width": 3, "border-color": css("--accent") } },
          { selector: "edge", style: { width: 1, label: "data(label)", "font-size": 8, color: css("--muted"), "line-color": css("--muted"), "target-arrow-shape": "triangle", "target-arrow-color": css("--muted"), "curve-style": "bezier", "text-rotation": "autorotate", "text-background-color": css("--panel"), "text-background-opacity": 1, "text-background-padding": 2 } },
        ],
        layout: { name: "concentric", concentric: function (n) { return n.data("me") ? 2 : 1; }, levelWidth: function () { return 1; }, startAngle: Math.PI, padding: 30, minNodeSpacing: 60 },
      });
      c.on("tap", "node", function (ev) { var n = byId[ev.target.id()]; if (n && n.id !== me) location.href = href(n.href); });
    };
    redraw.push(drawMini);
    drawMini();
  }

  // ── S8: the trace ───────────────────────────────────────────────────────
  var tr = $("#cytrace"), tstart = $("#tstart");
  if (tr && tstart) {
    var p2 = new URLSearchParams(location.search).get("start");
    if (p2 && reqById[p2]) tstart.value = p2;
    var drawTrace = function () {
      var r0 = reqById[tstart.value];
      if (!r0) return;
      var kids = {};
      D.reqs.forEach(function (r) { if (r.parent) (kids[r.parent] = kids[r.parent] || []).push(r); });
      var reqs = [], walk = function (r) { reqs.push(r); (kids[r.id] || []).forEach(walk); };
      walk(r0);
      var cols = [[], [], [], []], els = [], seen = {};
      var add = function (id, label, col, data) { if (seen[id]) return; seen[id] = 1; cols[col].push(id); data.id = id; data.label = label; els.push({ data: data }); };
      reqs.forEach(function (r) { add("r:" + r.id, (r.level ? "L" + r.level + " " : "") + r.label, r.level >= 4 ? 1 : 0, { col: r.status ? css("--" + r.status) : css("--muted"), shape: "round-rectangle", go: r.href }); });
      reqs.forEach(function (r) { if (r.parent && seen["r:" + r.parent]) els.push({ data: { id: "pe:" + r.id, source: "r:" + r.parent, target: "r:" + r.id } }); });
      reqs.forEach(function (r) {
        r.targets.forEach(function (t) {
          var n = byId[t];
          if (!n) return;
          add("o:" + t, n.name, 2, { col: kindColour(n), shape: shape(n), go: n.href, ring: n.unclaimed });
          if (!seen["le:" + r.id + ">" + t]) { seen["le:" + r.id + ">" + t] = 1; els.push({ data: { id: "le:" + r.id + ">" + t, source: "r:" + r.id, target: "o:" + t, col: r.status ? css("--" + r.status) : css("--muted") } }); }
        });
      });
      cols[2].slice().forEach(function (oid) {
        var id = oid.slice(2);
        var gen = D.generated[id] || [];
        if (!gen.length) return;
        var total = gen.reduce(function (a, g) { return a + g[1]; }, 0);
        var gid = "g:" + id;
        add(gid, total + " generated (" + gen.map(function (g) { return g[0]; }).join(", ") + ")", 3, { col: css("--accent"), shape: "tag", go: byId[id].href });
        els.push({ data: { id: "ge:" + gid, source: oid, target: gid } });
      });
      var pos = {};
      cols.forEach(function (c, ci) { c.forEach(function (id, i) { pos[id] = { x: ci * 260, y: (i - c.length / 2) * 26 }; }); });
      tr.innerHTML = "";
      var c = cytoscape({
        container: tr, elements: els, wheelSensitivity: 0.3, maxZoom: 1.6,
        style: [
          { selector: "node", style: { "background-color": "data(col)", label: "data(label)", shape: "data(shape)", "font-size": 11, color: css("--ink"), "text-halign": "right", "text-valign": "center", "text-margin-x": 6, width: 12, height: 12 } },
          { selector: "node[ring = 1]", style: { "border-width": 2, "border-color": css("--bad") } },
          { selector: "edge", style: { width: 1, "line-color": "data(col)", opacity: 0.5, "curve-style": "unbundled-bezier" } },
          { selector: "edge[!col]", style: { "line-color": css("--muted") } },
        ],
        layout: { name: "preset", positions: function (n) { return pos[n.id()]; }, fit: true, padding: 24 },
      });
      c.on("tap", "node", function (ev) { var go = ev.target.data("go"); if (go) location.href = href(go); });
    };
    tstart.onchange = function () {
      var u = new URL(location.href); u.searchParams.set("start", tstart.value); history.replaceState(null, "", u.pathname + u.search);
      drawTrace();
    };
    redraw.push(drawTrace);
    drawTrace();
  }
})();
