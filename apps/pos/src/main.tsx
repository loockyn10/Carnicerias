import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

function FoundationScreen() {
  return (
    <main className="grid min-h-screen place-items-center p-8">
      <section className="w-full max-w-2xl rounded-xl border border-stone-700 bg-stone-900 p-8">
        <p className="text-sm font-semibold uppercase tracking-wider text-rose-400">Fase 1A</p>
        <h1 className="mt-2 text-3xl font-semibold">Base POS preparada</h1>
        <p className="mt-4 leading-7 text-stone-300">
          Esta aplicación web es solo el punto de entrada. Tauri, SQLite, ventas y sincronización se
          incorporarán en la fase offline-first.
        </p>
      </section>
    </main>
  );
}

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (!rootElement) throw new Error("Missing root element");

createRoot(rootElement).render(
  <StrictMode>
    <FoundationScreen />
  </StrictMode>
);

