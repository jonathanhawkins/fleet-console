import type { Metadata } from "next";

/** The product's name as an unfurler prints it, and as the tab shows it. */
export const SITE_NAME = "Robot Fleet Console";

/**
 * The two places a route has to state its own address, stated once.
 *
 * `alternates.canonical` and `openGraph.url` are the same fact — where this
 * page lives — resolved against `metadataBase` the same way, but Next keeps
 * them in different branches of the metadata object. A route that sets one and
 * forgets the other is not obviously broken from the source: it ships a card
 * whose link points at whatever the root declared.
 *
 * The `openGraph` block repeats `type` and `siteName` on purpose. Next
 * replaces that object wholesale rather than merging it, so a route that
 * declares `openGraph` at all drops everything the layout put there. The card
 * image is the one exception — it comes from the `opengraph-image` file
 * convention and is re-attached after this resolves, which holds only while
 * nothing here names `images`.
 */
export function routeAddress(path: string): Pick<Metadata, "alternates" | "openGraph"> {
  return {
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: SITE_NAME, url: path },
  };
}
