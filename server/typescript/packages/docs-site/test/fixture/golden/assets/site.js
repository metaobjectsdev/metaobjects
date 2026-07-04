// mermaid: theme comes from each diagram's %%{init}%% prelude; useMaxWidth fits diagrams to the
// container width. The .pl-diagram box scrolls (native, mobile-friendly) if a diagram is tall.
mermaid.initialize({ startOnLoad: false, securityLevel: "loose", er: { useMaxWidth: true }, flowchart: { useMaxWidth: true } });
mermaid.run({ querySelector: ".mermaid" });
// scroll-spy TOC
const secs = [...document.querySelectorAll("section[id]")];
const tocLinks = new Map([...document.querySelectorAll(".pl-toc a")].map((a) => [a.getAttribute("href").replace(/^#/, ""), a]));
if (secs.length && tocLinks.size) {
  const io = new IntersectionObserver((es) => es.forEach((e) => { const a = tocLinks.get(e.target.id); if (a) a.classList.toggle("active", e.isIntersecting); }), { rootMargin: "0px 0px -70% 0px" });
  secs.forEach((s) => io.observe(s));
}
// Cmd+K search
const modal = document.getElementById("search-modal"), box = document.getElementById("search"), results = document.getElementById("search-results");
const openBtn = document.getElementById("search-open");
const open = () => { modal?.showModal(); box.value = ""; results.innerHTML = ""; box.focus(); };
openBtn?.addEventListener("click", open);
document.addEventListener("keydown", (e) => { if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && document.activeElement !== box)) { e.preventDefault(); open(); } });
let INDEX = null;
box?.addEventListener("input", async () => {
  INDEX ??= await (await fetch(window.__REL_ROOT__ + "assets/search-index.json")).json();
  const q = box.value.trim().toLowerCase();
  if (!q) { results.innerHTML = ""; return; }
  const scored = INDEX.map((e) => { const t = e.t.toLowerCase(); const i = t.indexOf(q); return i < 0 ? null : { e, s: (i === 0 ? 0 : 1) + t.length / 500 }; }).filter(Boolean).sort((a, b) => a.s - b.s).slice(0, 40);
  results.innerHTML = scored.map(({ e }) => `<a class="btn btn-ghost btn-sm justify-start font-mono font-normal" href="${window.__REL_ROOT__}${e.h}">${e.t} <span class="opacity-40 ml-auto">${e.k}</span></a>`).join("");
});
