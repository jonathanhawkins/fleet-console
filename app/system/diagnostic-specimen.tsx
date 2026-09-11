"use client";

import dynamic from "next/dynamic";
import { type DiagChannel, type DiagSession } from "@/lib/stores";

/**
 * The gallery's diagnostic specimen, behind its own chunk boundary.
 *
 * The regions themselves are real — this page renders the components the unit
 * page renders, not a picture of them — but importing them statically here made
 * the bundler hoist the canvas column into a chunk shared with the unit route,
 * which then paid for it eagerly. That route reaches the panel through a
 * `next/dynamic` gate precisely so it does not, and a documentation page is not
 * a good enough reason to undo it.
 *
 * A client component rather than a `dynamic()` call in the page: the page is a
 * server component (it exports `metadata`), and `ssr: false` is not available
 * to one.
 */

const ChannelColumn = dynamic(
  () => import("@/components/fleet/diagnostic").then((m) => m.ChannelColumn),
  { ssr: false },
);

const StructureList = dynamic(
  () => import("@/components/fleet/diagnostic").then((m) => m.StructureList),
  { ssr: false },
);

export function DiagnosticSpecimen({
  channels,
  session,
  subject,
}: {
  channels: readonly DiagChannel[];
  session: DiagSession;
  subject: string;
}) {
  return (
    <>
      <ChannelColumn channels={channels} subject={subject} />
      <StructureList session={session} />
    </>
  );
}
