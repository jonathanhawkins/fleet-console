import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import { ConsoleFooter } from "@/components/console";
import { SITE_URL } from "@/lib/constants";
import { SimReset, StorylineJump, TelemetryProvider } from "@/components/fleet";
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

const DESCRIPTION =
  "Eight home humanoid robots, joint telemetry at 10 Hz, and one incident that " +
  "walks an operator from a calm map into the machine's own diagnostics. " +
  "A design and engineering demo; all data is simulated.";

/**
 * `metadataBase` is what turns the file-convention images into the absolute
 * URLs a link unfurler needs — without it Next emits a relative path and every
 * preview card renders empty. The description is the product in one sentence
 * rather than the footer disclaimer, because this string is what search
 * results and preview cards show; the disclaimer still closes it, since the
 * one thing a card must not do is imply the fleet is real.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Fleet Console",
    template: "%s · Fleet Console",
  },
  description: DESCRIPTION,
  applicationName: "Fleet Console",
  openGraph: {
    type: "website",
    siteName: "Fleet Console",
    title: "Fleet Console",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Fleet Console",
    description: DESCRIPTION,
  },
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
        {/* First in the tab order on every route: a keyboard or screen-reader
            user lands on the page content without walking the header. Parked
            above the viewport until focused (a transform, so the pill keeps
            its padding and ground when it drops in); the global :focus-visible
            outline is its focus ring in both spaces, and the pill token
            flattens it in machine space. */}
        <a
          href="#main"
          className="fixed top-3 left-3 z-50 -translate-y-[200%] rounded-pill border border-line-strong bg-bg px-4 py-2 text-label text-ink uppercase focus:translate-y-0"
        >
          Skip to content
        </a>
        {/* Renders nothing; opens the telemetry link once, here in the shell,
            so that it survives navigation between the fleet map and a unit. */}
        <TelemetryProvider />
        {children}
        <ConsoleFooter>
          {/* The demo's controls, in the order someone uses them: pick a
              story, or start this one over. */}
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <StorylineJump />
            <SimReset />
          </div>
        </ConsoleFooter>
      </body>
    </html>
  );
}
