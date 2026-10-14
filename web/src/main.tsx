import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";

import { App } from "@/app/App";
import "@/styles/globals.css";

// With registerType "autoUpdate" this reloads the page once a newly deployed
// version has installed, instead of serving the cached one until next visit.
registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
