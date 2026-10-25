import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import "./index.css";
import { i18nReady } from "./lib/i18n";
import { queryClient, router } from "./router";

const container = document.getElementById("root");
if (!container) {
  throw new Error("main: #root element missing from index.html");
}

// Render once the detected language is loaded, so a Russian or Uzbek user never sees an English flash.
const root = createRoot(container);
void i18nReady.finally(() =>
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  ),
);
