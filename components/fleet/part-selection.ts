"use client";

import {
  COMPONENT_FOR_JOINT,
  COMPONENT_IDS,
  componentNamedIn,
  type ComponentId,
} from "./component-spec";
import { JOINTS, type Joint } from "@/components/console";

/**
 * One selected part, and everything that corresponds to it.
 *
 * The complaint about the first component view was that it was a picture
 * rather than an instrument: you could turn it, and that was all. The answer is
 * not more chrome on the viewer — it is making a selection *mean* something
 * everywhere else on the page. Pick the left knee actuator and the left knee's
 * three instruments come forward while the other five joints recede; pick it
 * and a detail card states its temperature, its last service and whether it is
 * the part the open incident is about.
 *
 * That is three regions of the page agreeing about one fact, and this module is
 * the fact. It holds two things and nothing else:
 *
 *   1. **The selection**, as a module singleton — the same shape and the same
 *      reasoning as telemetry-hover.ts. There is exactly one selected part at a
 *      time, on exactly one unit, and the viewer, the grid and the detail card
 *      all need it. Threading it through props would mean the unit page's whole
 *      subtree passing a `ComponentId` down two unrelated branches to reach a
 *      canvas that does not render.
 *   2. **The correspondences** — part → joints, joint → its opposite number —
 *      as pure functions over the maps that already exist in component-spec.ts
 *      and joint-spec.ts. Derived rather than restated: a ninth component or a
 *      seventh joint changes one table, not four.
 *
 * ## Why the selection carries a unit id
 *
 * Same reason the cursor does. A selection is only true of the page it was made
 * on, and a module variable outlives a route change — an operator who selects a
 * knee on N-07 and navigates to N-03 must not find N-03's left knee lit up on
 * the strength of a click they made about a different robot. Every read is
 * scoped, and the viewer clears on unmount.
 *
 * ## Why it is not React state
 *
 * The grid's cost model, unchanged: eighteen strips and thirty-six readouts
 * live under one subtree that is built to render exactly once. A selection
 * changes at click rate, not pointer rate, so a `useState` here would not be
 * expensive — but it would have to live *above* both the viewer and the grid,
 * which means every selection would re-render the entire unit page including
 * the eighteen canvases and the WebGL host. The grid instead subscribes here
 * and writes one data attribute per cell; CSS does the rest. See joint-grid.tsx.
 */

export interface PartSelection {
  unitId: string;
  part: ComponentId;
}

let selection: PartSelection | null = null;
const listeners = new Set<(selection: PartSelection | null) => void>();

/** The read every consumer makes: this unit's selected part, or null. */
export function selectedPartFor(unitId: string): ComponentId | null {
  return selection !== null && selection.unitId === unitId ? selection.part : null;
}

export function currentPartSelection(): PartSelection | null {
  return selection;
}

/**
 * Select a part, or pass `null` to clear. No-ops when nothing changed, so a
 * component re-asserting the selection it already holds costs no notification.
 */
export function setSelectedPart(unitId: string, part: ComponentId | null): void {
  if (part === null) {
    clearSelectedPart(unitId);
    return;
  }
  if (selection !== null && selection.unitId === unitId && selection.part === part)
    return;
  selection = { unitId, part };
  emit();
}

/** Unscoped when called with no id — the teardown path. */
export function clearSelectedPart(unitId?: string): void {
  if (selection === null) return;
  if (unitId !== undefined && selection.unitId !== unitId) return;
  selection = null;
  emit();
}

function emit(): void {
  for (const listener of listeners) listener(selection);
}

/**
 * Called synchronously on change. Safe for `useSyncExternalStore` (the viewer)
 * and for imperative DOM writes (the grid); a subscriber must not read layout
 * here beyond the one rect the grid needs to decide whether to scroll.
 */
export function subscribeSelection(
  listener: (selection: PartSelection | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests and teardown. */
export function resetPartSelection(): void {
  selection = null;
  listeners.clear();
}

/* ---------------------------------------------------------------------------
   Correspondences
--------------------------------------------------------------------------- */

/**
 * The joints a part is instrumented by — the inverse of COMPONENT_FOR_JOINT,
 * built from it rather than written out again.
 *
 * Four of the eight parts map to nothing, and that is the interesting half.
 * The chassis has a head, a torso and two arms; this fleet's telemetry has six
 * leg joints. Selecting the torso therefore has no strips to bring forward, and
 * the grid's rule for that case is **dim nothing** — an operator who clicks the
 * torso gets its detail card and a telemetry panel exactly as it was, rather
 * than eighteen instruments greyed out to announce an absence. Emphasis is only
 * meaningful when something is being emphasised.
 *
 * Order follows JOINTS (hips, knees, ankles), so a leg reads hip-then-ankle:
 * down the limb, which is how the grid stacks them and how anyone describes a
 * leg out loud.
 */
function invertJointMap(): Record<ComponentId, readonly Joint[]> {
  const table = {} as Record<ComponentId, Joint[]>;
  // Every part gets an entry, including the four that end up empty: a lookup
  // that can return `undefined` for a real component id is a lookup every
  // caller has to defend against.
  for (const id of COMPONENT_IDS) table[id] = [];
  for (const joint of JOINTS) {
    const part = COMPONENT_FOR_JOINT[joint];
    if (part) table[part]?.push(joint);
  }
  return table;
}

export const JOINTS_FOR_PART: Record<ComponentId, readonly Joint[]> = invertJointMap();

const NO_JOINTS: readonly Joint[] = [];

export function jointsForPart(part: ComponentId | null | undefined): readonly Joint[] {
  return part ? (JOINTS_FOR_PART[part] ?? NO_JOINTS) : NO_JOINTS;
}

/**
 * How loudly a joint's cell should be drawn, given the current selection.
 *
 * `null` means "no opinion" — leave the cell exactly as it is. It is returned
 * both when nothing is selected and when the selected part has no instruments,
 * which is the same instruction to the grid for two different reasons and is
 * deliberately not distinguished: the grid's job either way is to do nothing.
 */
export type JointEmphasis = "on" | "off" | null;

export function jointEmphasis(part: ComponentId | null, joint: string): JointEmphasis {
  const joints = jointsForPart(part);
  if (joints.length === 0) return null;
  return (joints as readonly string[]).includes(joint) ? "on" : "off";
}

/**
 * The same joint on the other leg, or null.
 *
 * Asymmetry between a pair is the first thing anyone looks for in a walking
 * machine — it is why the grid is laid out a leg at a time (joint-spec.ts) and
 * it is what the expanded strip's compare toggle overlays. Derived from the
 * wire's own `_L`/`_R` suffix and then checked against the roster, so a joint
 * that has no opposite number (or is not a joint at all) gets null rather than
 * a name nobody can look up.
 */
export function mirrorJoint(joint: string): Joint | null {
  const stem = joint.slice(0, -2);
  const flipped = joint.endsWith("_L")
    ? `${stem}_R`
    : joint.endsWith("_R")
      ? `${stem}_L`
      : null;
  if (flipped === null) return null;
  return (JOINTS as readonly string[]).includes(flipped) ? (flipped as Joint) : null;
}

/* ---------------------------------------------------------------------------
   The alert → viewer direction
--------------------------------------------------------------------------- */

/**
 * Select whatever part an alert's own sentence names, on the alert's own unit.
 *
 * "N-07: left knee actuator trending hot" already names a component in the same
 * vocabulary the viewer uses for it (componentNamedIn), so an alert row can
 * point the model at the thing it is about without deriving a suspect or
 * knowing that a viewer exists. Returns the part it selected, or null when the
 * alert names nothing pointable — a caller can use that to decide whether the
 * row is worth making clickable at all.
 *
 * Not yet wired from the alert row. Adopting it is one import and one handler:
 * `import { selectPartForAlert } from "./part-selection"` and
 * `onClick={() => selectPartForAlert(alert)}` on the row's existing press
 * target — nothing else here has to change, and a row on a page with no viewer
 * simply sets a value nobody reads.
 */
export function selectPartForAlert(alert: {
  unitId: string;
  message: string;
}): ComponentId | null {
  const part = componentNamedIn(alert.message);
  if (part === null) return null;
  setSelectedPart(alert.unitId, part);
  return part;
}
