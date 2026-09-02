import { describe, expect, it, vi } from "vitest";
import { type UnitSummary } from "@/lib/schema";
import { createMapReturn, offMapLabel, troubledOffMap } from "./map-return";

/**
 * Like the marker, the return control is DOM React never renders, so the DOM
 * is the only place its contract can be pinned: that it stays out of the way
 * at the home framing, that the alert state outranks the neutral one, and
 * that the count it shows is troubled-and-off-map, not either alone.
 */

const unit = (over: Partial<UnitSummary> = {}): UnitSummary => ({
  id: "N-07",
  name: "Sagebrush House",
  status: "nominal",
  battery: 82,
  pos: { lat: 44.0597, lng: -121.2793 },
  ...over,
});

const present = (u: UnitSummary): [number, number] => [u.pos.lng, u.pos.lat];

describe("offMapLabel", () => {
  it("counts in operator English", () => {
    expect(offMapLabel(1)).toBe("1 alert off map");
    expect(offMapLabel(3)).toBe("3 alerts off map");
  });
});

describe("troubledOffMap", () => {
  const everything = () => true;
  const nothing = () => false;

  it("counts only units that are both troubled and outside the view", () => {
    const units = [
      unit({ id: "N-01" }), // nominal, off-map: not counted
      unit({ id: "N-07", status: "red" }),
      unit({ id: "N-02", status: "amber" }),
    ];
    expect(troubledOffMap(units, nothing, present)).toBe(2);
    expect(troubledOffMap(units, everything, present)).toBe(0);
  });

  it("judges visibility on the presented position, not the true one", () => {
    const shifted = (_u: UnitSummary): [number, number] => [0, 0];
    const seen: Array<[number, number]> = [];
    const inView = (lng: number, lat: number): boolean => {
      seen.push([lng, lat]);
      return false;
    };
    troubledOffMap([unit({ status: "red" })], inView, shifted);
    expect(seen).toEqual([[0, 0]]);
  });
});

describe("createMapReturn", () => {
  it("renders nothing at the home framing", () => {
    const { el, update } = createMapReturn(vi.fn());
    expect(el.hidden).toBe(true);
    update({ away: false, offMap: 0 });
    expect(el.hidden).toBe(true);
  });

  it("offers the way home once the operator has wandered", () => {
    const { el, update } = createMapReturn(vi.fn());
    update({ away: true, offMap: 0 });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("Recenter");
    expect("alerting" in el.dataset).toBe(false);
  });

  it("escalates to the off-map count and stands down again", () => {
    const { el, update } = createMapReturn(vi.fn());
    update({ away: true, offMap: 2 });
    expect(el.textContent).toBe("2 alerts off map");
    expect("alerting" in el.dataset).toBe(true);

    update({ away: true, offMap: 0 });
    expect(el.textContent).toBe("Recenter");
    expect("alerting" in el.dataset).toBe(false);

    update({ away: false, offMap: 0 });
    expect(el.hidden).toBe(true);
  });

  it("shows the alert state even when the camera was moved by the map itself", () => {
    // An automatic push-in that noses a troubled unit out of frame: away is
    // false, but a troubled unit off-screen is a reason to exist regardless
    // of whose hand moved the camera.
    const { el, update } = createMapReturn(vi.fn());
    update({ away: false, offMap: 1 });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("1 alert off map");
  });

  it("is a real button that fires the return", () => {
    const onReturn = vi.fn();
    const { el, update } = createMapReturn(onReturn);
    update({ away: true, offMap: 0 });
    expect(el.tagName).toBe("BUTTON");
    // type=button: a map control inside any future <form> must never submit it
    expect(el.getAttribute("type")).toBe("button");
    el.click();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
