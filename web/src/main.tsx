import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { Toaster } from "@/components/ui/toast";

function Root() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <h1 className="text-lg font-semibold">Runtime Console</h1>
      <Toaster />
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("main: #root element missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
