import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/admin",
    name: "Administración Carnicerías",
    short_name: "Administración",
    description: "Panel interno de gestión",
    start_url: "/admin",
    scope: "/",
    display: "standalone",
    background_color: "#f5f4f1",
    theme_color: "#9f1239",
    lang: "es-AR",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
