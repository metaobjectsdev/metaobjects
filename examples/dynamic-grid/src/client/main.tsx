import { createRoot } from "react-dom/client";
import { App } from "./app";

const mount = document.getElementById("app");
if (mount === null) throw new Error("index.html has no #app element to render into");
// The API is mounted under /api (src/server/app.ts). The browser is told so here, at
// runtime: nothing generated carries it.
createRoot(mount).render(<App baseUrl="/api" />);
