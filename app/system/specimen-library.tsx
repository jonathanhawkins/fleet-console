"use client";

import dynamic from "next/dynamic";

/**
 * The catalogue, fetched rather than shipped.
 *
 * Fourteen specimens each render twice — once per space, which is the page's
 * whole claim — so the list is the bulk of this route in both of the forms a
 * visitor can pay for it: the prerendered document, and the flight payload the
 * router fetches instead on a client-side navigation. Deferring it takes the
 * markup out of both, and the three sections above it are unaffected.
 *
 * `ssr: false`, so this is a client component rather than a `dynamic()` call in
 * the page: the page is a server component, and the option is only legal on
 * this side of the boundary (diagnostic-specimen.tsx is here for the same
 * reason).
 */
const SpecimenList = dynamic(
  () => import("./specimen-list").then((m) => m.SpecimenList),
  {
    ssr: false,
    // The catalogue is the end of the document, so what this holds open is the
    // scrollbar rather than a neighbour — nothing follows it to be pushed down.
    loading: () => <div className="min-h-[60rem]" />,
  },
);

export function SpecimenLibrary() {
  return <SpecimenList />;
}
