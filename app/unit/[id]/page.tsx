import type { Metadata } from "next";
import { ConsoleHeader, LiveConnectionStatus } from "@/components/console";
import { FLEET_UNITS } from "@/sim/engine";
import { UnitDetail } from "./unit-detail";

/**
 * /unit/[id] — the drill-in.
 *
 * The server's whole job on this route is the chrome: the shared header, the
 * page column, and the title in the tab. Everything with a number in it is
 * client-rendered from the live stores (see UnitDetail), and the footer
 * disclaimer comes from the root layout, so it cannot be forgotten here.
 *
 * The header's right cluster drops the fleet page's "Design system" link and
 * keeps the connection status: on a page of live instruments, whether the
 * numbers are still arriving is the one piece of chrome that qualifies
 * everything else on screen.
 */

interface UnitPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Static export needs the route enumerable at build time, and the enumeration
 * must not be a second copy of the fleet: the ids come from `FLEET_UNITS` in
 * sim/engine.ts — the same roster the sim engine snapshots from — so a ninth
 * unit added to the sim is a ninth static page, with no string array to forget.
 * (Build-time only: the engine never reaches the client through this import;
 * the browser gets it solely inside the worker chunk.)
 */
export function generateStaticParams(): Array<{ id: string }> {
  return FLEET_UNITS.map((unit) => ({ id: unit.id }));
}

/**
 * Only roster units exist as pages. On the static build there is no server to
 * render other ids anyway; declaring it keeps the dev server honest too.
 */
export const dynamicParams = false;

export async function generateMetadata({ params }: UnitPageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: decodeURIComponent(id) };
}

export default async function UnitPage({ params }: UnitPageProps) {
  const { id } = await params;

  return (
    <>
      <ConsoleHeader>
        <LiveConnectionStatus />
      </ConsoleHeader>

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-5 py-6 sm:gap-8 sm:px-8 sm:py-8 md:gap-10 md:px-16 md:py-10 lg:px-24">
        <UnitDetail unitId={decodeURIComponent(id)} />
      </main>
    </>
  );
}
