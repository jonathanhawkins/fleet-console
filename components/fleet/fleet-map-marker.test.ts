import { describe, expect, it, vi } from "vitest";
import { type UnitSummary } from "@/lib/schema";
import { createUnitMarker, isPlainLeftClick, unitHref } from "./fleet-map-marker";
import { alertSeverityChip, unitStatusChip, unitStatusCopy } from "@/components/console";

/**
 * The marker is the one piece of UI in this app that React never renders, so
 * it is also the one piece with no component test to fall back on. What is
 * worth pinning down: that the wire vocabulary reaches the DOM as the token
 * vocabulary, that a status change is a *mutation* rather than a re-creation,
 * and that the thing an operator clicks behaves like a link.
 */

const unit = (over: Partial<UnitSummary> = {}): UnitSummary => ({
  id: "N-07",
  name: "Sagebrush House",
  status: "nominal",
  battery: 82,
  pos: { lat: 44.0597, lng: -121.2793 },
  ...over,
});

describe("status vocabulary", () => {
  it("translates the wire's status names to the token names", () => {
    expect(unitStatusChip("nominal")).toBe("nominal");
    expect(unitStatusChip("amber")).toBe("warn");
    expect(unitStatusChip("red")).toBe("alert");
  });

  it("reads alert severities from the same table, so the two cannot drift", () => {
    expect(alertSeverityChip("amber")).toBe(unitStatusChip("amber"));
    expect(alertSeverityChip("red")).toBe(unitStatusChip("red"));
  });

  it("speaks operator English, not enum", () => {
    expect(unitStatusCopy("amber")).toBe("Attention");
    expect(unitStatusCopy("red")).toBe("Alert");
    expect(unitStatusCopy("nominal")).toBe("Nominal");
  });
});

describe("createUnitMarker", () => {
  it("is a real link to the unit's drill-in route", () => {
    const { el } = createUnitMarker(unit(), vi.fn());
    expect(el.tagName).toBe("A");
    expect(el.getAttribute("href")).toBe("/unit/N-07");
    expect(unitHref("N-01")).toBe("/unit/N-01");
    // claimed up front so MapLibre cannot stamp role="button" over it
    expect(el.getAttribute("role")).toBe("link");
  });

  it("carries the token status and an accessible name that states it", () => {
    const { el } = createUnitMarker(unit({ status: "red" }), vi.fn());
    expect(el.dataset.status).toBe("alert");
    expect(el.getAttribute("aria-label")).toBe("N-07, Sagebrush House. Alert.");
  });

  it("hides its visible label from assistive tech — the aria-label already says it", () => {
    const { el } = createUnitMarker(unit(), vi.fn());
    const label = el.querySelector(".fleet-marker__label");
    expect(label).toHaveTextContent("N-07 · Sagebrush House");
    expect(label).toHaveAttribute("aria-hidden", "true");
  });

  it("mutates in place on a status change rather than rebuilding the node", () => {
    const marker = createUnitMarker(unit(), vi.fn());
    const dial = marker.el.querySelector(".fleet-marker__dial");

    marker.update(unit({ status: "amber" }));
    expect(marker.el.dataset.status).toBe("warn");
    marker.update(unit({ status: "red" }));
    expect(marker.el.dataset.status).toBe("alert");

    // same element, same children: nothing was re-created under the map
    expect(marker.el.querySelector(".fleet-marker__dial")).toBe(dial);
  });

  it("rings once when a unit worsens, and not when it recovers", () => {
    const marker = createUnitMarker(unit(), vi.fn());
    expect(marker.el.dataset.ping).toBeUndefined();

    marker.update(unit({ status: "amber" }));
    expect(marker.el.dataset.ping).toBe("");

    // the animation's own `animationend` clears this in the browser; jsdom
    // does not run animations, so clear it by hand to test the next edge
    delete marker.el.dataset.ping;
    marker.update(unit({ status: "nominal" }));
    expect(marker.el.dataset.ping).toBeUndefined();
  });

  it("does not ring for an incident that was already underway when it mounted", () => {
    const marker = createUnitMarker(unit({ status: "red" }), vi.fn());
    expect(marker.el.dataset.status).toBe("alert");
    expect(marker.el.dataset.ping).toBeUndefined();
  });

  it("navigates on a plain click and leaves modified clicks to the browser", () => {
    const onNavigate = vi.fn();
    const { el } = createUnitMarker(unit(), onNavigate);
    // The modified click below is *meant* to fall through to the browser, so
    // jsdom logs one "Not implemented: navigation to another Document" to
    // stderr when it does. That line is the assertion passing, not a failure.

    const plain = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    el.dispatchEvent(plain);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(plain.defaultPrevented).toBe(true);

    const meta = new MouseEvent("click", {
      button: 0,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(meta);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(meta.defaultPrevented).toBe(false);
  });
});

describe("isPlainLeftClick", () => {
  it("is true only for an unmodified primary click", () => {
    expect(isPlainLeftClick(new MouseEvent("click", { button: 0 }))).toBe(true);
    expect(isPlainLeftClick(new MouseEvent("click", { button: 1 }))).toBe(false);
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(
        isPlainLeftClick(new MouseEvent("click", { button: 0, [modifier]: true })),
      ).toBe(false);
    }
  });
});
