import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "Stocky" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1a3c6e" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <a className="skip" href="#contenido">Ir al contenido</a>
        {children}
      </body>
    </html>
  );
}
