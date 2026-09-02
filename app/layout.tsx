import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import { ConsoleFooter, TelemetryProvider } from "@/components/console";
import "./globals.css";

/** Operator space. Sentence case, wide-tracked uppercase labels. */
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

/** Machine space. Everything the robot says, it says in this. */
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Fleet Console",
    template: "%s · Fleet Console",
  },
  description: "A design and engineering demo. All data is simulated.",
};

export const viewport: Viewport = {
  themeColor: "#fafaf9",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Operator space is the default world. Machine space is entered, never toggled.
    // Both font variables live on <html> so that --font-space (declared in the
    // same [data-space] block) can resolve them; declared on <body> they would
    // be invalid at computed-value time on the element that reads them.
    <html
      lang="en"
      data-space="operator"
      className={`${geistSans.variable} ${jetbrainsMono.variable}`}
    >
      {/* body is the shell column (see app/globals.css): pages render header and
          main, the footer is rendered once, here, so that the disclaimer cannot
          be forgotten on a route added later. */}
      <body>
        {/* Renders nothing; opens the telemetry link once, here in the shell,
            so that it survives navigation between the fleet map and a unit. */}
        <TelemetryProvider />
        {children}
        <ConsoleFooter />
      </body>
    </html>
  );
}
