import { type UnitSummary } from "@/lib/schema";

/**
 * The map's way back, built as DOM rather than as React for the same reason
 * the markers are (fleet-map-marker.ts): it lives inside the map container,
 * updates on camera events, and must never make React reconcile a map.
 *
 * One control, two states. After the operator moves the camera it reads
 * "Recenter" — the answer to a map of empty prairie with the fleet somewhere
 * off the edge. When a troubled unit is outside the viewport it escalates to
 * an alert-styled count ("1 alert off map"), because at that moment the
 * problem is not that the operator is lost, it is that the thing worth
 * looking at is not in the frame. Both states click through to the same
 * action — restore the framing that shows everything — so the control never
 * asks the operator to choose between orientation and coverage.
 *
 * At the home framing it renders nothing at all: fitBounds contains every
 * unit by construction, so a visible control there could only state the
 * obvious.
 */

export interface MapReturnState {
  /** The operator has moved the camera off the home framing. */
  away: boolean;
  /** Troubled (non-nominal) units currently outside the viewport. */
  offMap: number;
}

export interface MapReturn {
  /** Absolutely positioned; append inside the `.fleet-map` container. */
  readonly el: HTMLButtonElement;
  /** Re-state the control. Cheap; safe to call per camera settle. */
  update(state: MapReturnState): void;
}

/** Operator English; CSS owns the small-caps presentation. */
export function offMapLabel(count: number): string {
  return count === 1 ? "1 alert off map" : `${count} alerts off map`;
}

/**
 * How many troubled units the current viewport is not showing. Positions go
 * through the same presentation transform the markers use — the control must
 * count the pins the map actually draws, not the true coordinates it never
 * sees (fleet-map-privacy.ts).
 */
export function troubledOffMap(
  units: readonly UnitSummary[],
  inView: (lng: number, lat: number) => boolean,
  present: (u: UnitSummary) => [number, number],
): number {
  let n = 0;
  for (const u of units) {
    if (u.status === "nominal") continue;
    const [lng, lat] = present(u);
    if (!inView(lng, lat)) n += 1;
  }
  return n;
}

export function createMapReturn(onReturn: () => void): MapReturn {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "map-return";
  el.hidden = true;
  el.addEventListener("click", onReturn);

  const update = (state: MapReturnState): void => {
    // offMap > 0 implies the frame is not home, whoever moved the camera —
    // an automatic push-in that noses a cohort unit out counts too.
    const visible = state.away || state.offMap > 0;
    if (el.hidden !== !visible) el.hidden = !visible;
    if (!visible) return;
    const alerting = state.offMap > 0;
    const text = alerting ? offMapLabel(state.offMap) : "Recenter";
    if (el.textContent !== text) el.textContent = text;
    if (alerting) el.dataset.alerting = "";
    else delete el.dataset.alerting;
  };

  return { el, update };
}
