import { type UnitSummary } from "@/lib/schema";
import { unitStatusChip, unitStatusCopy } from "./unit-status";

/**
 * The map marker, built as DOM rather than as React.
 *
 * PRD §7 is explicit that map markers are updated imperatively, so this module
 * deals in elements and mutations, not components: create eight of these once,
 * then poke `data-status` when a status changes. A telemetry batch never
 * touches React because React never owned these nodes in the first place.
 *
 * Every visual property lives in `.fleet-marker` in app/globals.css — the
 * element here carries structure and state (`data-status`), the stylesheet
 * carries the tokens. Nothing in this file knows a colour.
 */

/**
 * Our own artwork: an isometric house in three strokes, drawn in the grammar
 * of the reference factory diagram — a corner-on volume, hairline weight, no
 * fill, no shading.
 *
 * Geometry (24×24, y down). Isometric axes are (+9,+5) and (−9,+5); the near
 * corner sits at (12,20), the footprint diamond spans (3,15)–(21,15), and the
 * walls rise 6. The roof is a *gable*, not a pyramid: a ridge from (7.5,3) to
 * (16.5,8) gives one long slope and one triangular gable end. That was the
 * whole difference between "house" and "crate" at 18 px — a pyramid roof
 * reads as the top of a cube, and a shallow ridge reads as a lid.
 */
const HOUSE_GLYPH = `<svg class="fleet-marker__glyph" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9v6l9 5 9-5V9M12 20v-6"/><path d="M12 14 3 9l4.5-6L16.5 8Z"/><path d="M12 14l9-5-4.5-1Z"/></g></svg>`;

export interface UnitMarker {
  /** The root element handed to `new maplibregl.Marker({ element })`. */
  readonly el: HTMLAnchorElement;
  /**
   * Re-state this marker from a fresh summary. Cheap; safe to call per batch.
   *
   * `cohort` is the suspect firmware when this unit is part of a live fleet
   * incident. It rides the same attribute-write mechanism as status — the
   * element still knows no colour — and it is deliberately a SECOND channel
   * rather than a fifth `data-status` value: a unit in a cohort is still amber,
   * or still nominal, and collapsing the two would lose whichever fact lost the
   * argument.
   */
  update(unit: UnitSummary, cohort?: string): void;
}

/** `/unit/N-07` — the drill-in route (Phase 2). */
export function unitHref(unitId: string): string {
  return `/unit/${unitId}`;
}

/**
 * A left click with no modifier is ours to handle; anything else belongs to
 * the browser. Honouring that is what makes this a real link rather than a div
 * that navigates: cmd-click opens the unit in a new tab, and the status bar
 * shows a URL on hover.
 */
export function isPlainLeftClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function createUnitMarker(
  unit: UnitSummary,
  onNavigate: (href: string) => void,
  cohort?: string,
): UnitMarker {
  const el = document.createElement("a");
  el.className = "fleet-marker";
  el.href = unitHref(unit.id);
  el.dataset.unit = unit.id;
  // Redundant on an <a href> — except that MapLibre stamps role="button" onto
  // any marker element that does not already declare one (Marker.addTo), which
  // would tell a screen reader this is a button when it is a link to a route.
  // Claiming the role first is what stops that.
  el.setAttribute("role", "link");

  // The visible label is decorative duplication of the accessible name below,
  // so it is hidden from assistive tech rather than read out twice.
  el.innerHTML = `<span class="fleet-marker__dial" aria-hidden="true"><span class="fleet-marker__ping"></span>${HOUSE_GLYPH}</span><span class="fleet-marker__label" aria-hidden="true"></span>`;

  const label = el.querySelector<HTMLSpanElement>(".fleet-marker__label");
  const ping = el.querySelector<HTMLSpanElement>(".fleet-marker__ping");

  // A single expanding ring when a unit's status *worsens* — an event, not an
  // ambience. A marker that pulses forever is a nav app trying to get your
  // attention; a marker that rings once is a fleet console telling you
  // something just happened, and then going quiet again.
  ping?.addEventListener("animationend", () => {
    delete el.dataset.ping;
  });

  el.addEventListener("click", (event) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    // Enter on a focused anchor dispatches a click, so keyboard activation
    // arrives here too — no second key handler to keep in sync.
    onNavigate(el.href);
  });

  const update = (next: UnitSummary, nextCohort?: string): void => {
    if (el.dataset.cohort !== nextCohort) {
      if (nextCohort === undefined) delete el.dataset.cohort;
      else el.dataset.cohort = nextCohort;
    }
    const status = unitStatusChip(next.status);
    if (el.dataset.status !== status) {
      // `!== undefined` matters: a marker created for a unit that is already
      // amber (a page opened mid-incident) must not ring for old news.
      const worsened = el.dataset.status !== undefined && status !== "nominal";
      el.dataset.status = status;
      if (worsened) {
        // Re-adding the attribute restarts the animation; the reflow read
        // between the two writes is what makes the restart actually take.
        delete el.dataset.ping;
        void el.offsetWidth;
        el.dataset.ping = "";
      }
    }
    const text = `${next.id} · ${next.name}`;
    if (label && label.textContent !== text) label.textContent = text;
    const name = `${next.id}, ${next.name}. ${unitStatusCopy(next.status)}.`;
    if (el.getAttribute("aria-label") !== name) el.setAttribute("aria-label", name);
  };

  update(unit, cohort);
  return { el, update };
}
