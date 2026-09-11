export { DiagnosticPanel } from "./panel";
export type { DiagnosticPanelProps } from "./panel";

/**
 * The two regions the design-system gallery renders directly.
 *
 * Exported from this subpath rather than the fleet barrel on purpose: the unit
 * page reaches the panel through a `next/dynamic` gate, and putting these in
 * the barrel it imports would make them statically reachable from the route
 * whose budget the gate exists to protect.
 */
export { ChannelColumn } from "./channel-column";
export type { ChannelColumnProps } from "./channel-column";
export { StructureList } from "./structure-list";
export type { StructureListProps } from "./structure-list";
