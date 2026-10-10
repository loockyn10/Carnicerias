import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Administración Carnicerías",
  description: "Panel interno de gestión",
  applicationName: "Administración Carnicerías",
  appleWebApp: { capable: true, title: "Administración" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" }
};

// viewport-fit=cover: el celular usa toda la pantalla y las barras fijas respetan el área segura (env(safe-area-inset-*)).
export const viewport: Viewport = { themeColor: "#9f1239", viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es-AR">
      <body>{children}</body>
    </html>
  );
}

