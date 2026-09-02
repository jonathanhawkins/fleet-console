"use client";

import { selectTrendingUnits, useFleetStore, type TrendingUnit } from "@/lib/stores";
import { jointLabel } from "./joint-spec";

/**
 * Operator space's half of the thermal trend watch (lib/stores/trendWatch.ts).
 *
 * The store decides *whether* a joint is climbing; this module decides how the
 * console says so — and the answer is: quietly. Trending sits below amber on
 * purpose. It is a forecast about a unit that is still nominal, so it must not
 * borrow the ATTENTION/ALERT vocabulary it is trying to pre-empt: no chip, no
 * tint, no pill, no second severity for an operator to rank. One warm word in
 * `--warn-ink` and a sentence-case measurement, one step down from the chip
 * that would be there if this were real.
 *
 * Everything below is pure string work over `TrendingUnit`, which is what makes
 * it testable without a store and reusable by the row, its accessible name, and
 * anything later that wants to say the same thing (the unit page's header, a
 * report line). The joint vocabulary is NOT re-invented here: `jointLabel` in
 * joint-spec.ts is the single wire→operator mapping, and a second one would be
 * a second chance for "knee_L" to reach a human.
 */

/**
 * "Left knee" → "left knee".
 *
 * `jointLabel` answers a *heading* ("Left knee", over a telemetry strip); this
 * line is running text following a middot, where the row already speaks in
 * sentence case ("just now", "80%"). Capitalising mid-line would make the joint
 * read as a new label rather than as the subject of the sentence — so the case
 * is adjusted at the point of use and the mapping stays single.
 */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The measurement half of the line: "left knee +18 °C/min".
 *
 * The sign is explicit and always positive — the watch only ever reports a
 * climb (the store's enter threshold is +12 °C/min) — because "18 °C/min" on a
 * temperature row could be read as a *value* by someone scanning fast. `+` is
 * one character that makes it a rate.
 */
export function trendDetail(trend: TrendingUnit): string {
  return `${lowerFirst(jointLabel(trend.joint))} +${trend.cPerMin} °C/min`;
}

/**
 * The same fact as one spoken clause, for a row's assembled accessible name.
 *
 * Symbols are spelled out for the same reason `UnitCard` says "Battery 80
 * percent": a screen reader's handling of "°C/min" ranges from "degrees
 * Celsius per minute" to silence depending on the engine, and an ops console
 * does not get to gamble on which.
 */
export function trendSpeech(trend: TrendingUnit): string {
  return `Trending: ${lowerFirst(jointLabel(trend.joint))} climbing ${trend.cPerMin} degrees Celsius per minute.`;
}

/**
 * One unit's watch entry, or `undefined`.
 *
 * `selectTrendingUnits` keeps its array identity while trending truth is
 * unchanged (lib/stores/trendWatch.ts), so the element found inside it is
 * `Object.is`-stable too — which is what lets a virtualized row subscribe to
 * this bare and re-render only when its own forecast actually moves, not ten
 * times a second. For hosts that have a unit id and nothing else; the fleet
 * rail passes the entry down instead, for the reason stated there.
 */
export function useTrendingUnit(unitId: string): TrendingUnit | undefined {
  return useFleetStore((s) => selectTrendingUnits(s).find((t) => t.unitId === unitId));
}
