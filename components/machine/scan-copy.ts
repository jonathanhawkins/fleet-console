import { JOINTS } from "@/components/console";
import { type VerdictReport } from "@/lib/schema";
import { type ScanLink } from "./scan-state";

/**
 * The machine's voice, in one file.
 *
 * PRD §5: machine space speaks in terse uppercase system voice — "SCANNING
 * ACTUATOR BUS", "CHANNEL 06 DIVERGENCE". Scattering that across six
 * components is how a system voice becomes six voices, so every uppercase
 * string the scan says about its own progress is composed here, from store
 * state, and asserted in scan-copy.test.ts.
 *
 * Two rules the strings obey. They never claim a count the session has not
 * actually received — a status line reading "CHANNEL 06/06" while four
 * channels are in would be the console inventing progress. And they never
 * apologise or explain; the operator gets what is happening and, when
 * something is wrong, what is being held.
 */

/** Wire names go uppercase and keep their underscore: KNEE_L, not "Left knee". */
export const machineJoint = (joint: string): string => joint.toUpperCase();

/** `actuator_A07` → `ACTUATOR A-07`, the form the verdict headline uses. */
export function machineComponent(component: string): string {
  return component
    .replace(/_/g, " ")
    .replace(/\b([A-Za-z])(\d+)\b/g, "$1-$2")
    .toUpperCase();
}

/**
 * The verdict collapsed to one line, for the status bar it minimizes into:
 * `VERDICT · KNEE_L · A-07 GAIN`.
 *
 * It has to survive being the *only* thing left of the conclusion on screen, so
 * it carries the three facts an operator would need to decide whether to reopen
 * it — where, which part, what kind of wrong — and nothing else. The part
 * number is the tail of the component id when the tail is a part number
 * (`ACTUATOR A-07` → `A-07`); anything else keeps its full name, because
 * shortening `SPINE BUS` to `BUS` would be trading a fact for four characters.
 */
export const VERDICT_CHIP_HEAD = "VERDICT";

/**
 * The three facts, without the head word.
 *
 * Split out because on a 375px status line the chip cannot print all of it:
 * the head and the RESTORE that follows are the two halves that must stay
 * legible — one says what the chip is, the other says what tapping it does —
 * so it is this detail that gives way to an ellipsis in between. Composed here
 * rather than sliced at the call site, so the seam is a function boundary and
 * not an index into a string.
 */
export function verdictChipDetail(report: VerdictReport): string {
  if (report.anomaly === "none") return "NO ANOMALY";
  const full = machineComponent(report.component);
  const tail = full.split(" ").at(-1) ?? full;
  const part = /^[A-Z]-\d+$/.test(tail) ? tail : full;
  return `${machineJoint(report.joint)} · ${part} ${report.anomaly.toUpperCase()}`;
}

export function verdictChipLabel(report: VerdictReport): string {
  return `${VERDICT_CHIP_HEAD} · ${verdictChipDetail(report)}`;
}

/**
 * What else the signature could be: the differential, one line under
 * the anomaly headline.
 *
 * A scan measures a signature; it does not open the knee. "GAIN ANOMALY" is
 * what the trace shows — this line is the list of faults that produce that
 * trace, so the verdict reads as a hypothesis with evidence rather than a
 * teardown that never happened. Keyed by anomaly, and absent for anomalies
 * this table has no differential for: the machine lists what it knows or says
 * nothing, it does not improvise pathology. The healthy verdict never shows
 * one — "none" is deliberately not a key.
 *
 * Machine voice, caps written literally (the commandLine rule): the operator
 * page's report builds its own operator-voice twin of this from the same
 * facts; this one stays terse.
 */
export const ANOMALY_DIFFERENTIALS: Readonly<Record<string, readonly string[]>> = {
  gain: ["GAIN DRIFT", "TENDON WEAR", "ACTUATOR DEGRADATION"],
  // Cheapest to establish first, like the gain list: a displaced
  // trace with its envelope intact is most often a reference the joint has
  // lost, and the two mechanical candidates behind it are what a re-zero that
  // does not hold would leave. The operator page prints its own translation of
  // the same three (incident-report-surface.tsx); this one stays terse.
  offset: ["ENCODER ZERO DRIFT", "MOUNT SHIFT", "LINKAGE BACKLASH"],
};

export function anomalyDifferential(anomaly: string): string | null {
  const causes = ANOMALY_DIFFERENTIALS[anomaly];
  return causes ? `CONSISTENT WITH ${causes.join(" · ")}` : null;
}

/** Zero-padded ordinal, the manifest and log gutter's shared idiom. */
export const pad4 = (n: number): string => String(n).padStart(4, "0");
export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `T+01:23` — elapsed since the scan opened, on the app's one-second ticker. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `T+${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export interface ScanProgress {
  walked: number;
  channels: number;
  flagged: boolean;
  hasVerdict: boolean;
}

/**
 * The bottom rule's status line: what the scanner is doing, right now, in the
 * fewest words that are still true.
 *
 * The link state outranks progress. A held scan that kept reporting "CHANNEL
 * 03/06" would be stating a fact that stopped being live the moment the socket
 * dropped — the number is still true about what arrived, and completely
 * misleading about what is happening.
 */
export function scanStatusLine(
  progress: ScanProgress,
  link: ScanLink,
  phase: "scanning" | "verdict",
): string {
  if (link === "lost") return "HOLD · LINK LOST · SESSION RETAINED";
  if (link === "resumed") return "HOLD · LINK RESTORED · AWAITING SEQUENCE";

  if (phase === "verdict") {
    return progress.flagged
      ? `SCAN COMPLETE · ${pad2(progress.channels)} CHANNELS · 01 ANOMALY`
      : `SCAN COMPLETE · ${pad2(progress.channels)} CHANNELS · NO ANOMALY`;
  }

  if (progress.channels > 0) {
    const of = `${pad2(progress.channels)}/${pad2(JOINTS.length)}`;
    return progress.flagged
      ? `SCANNING ACTUATOR BUS · CHANNEL ${of} · DIVERGENCE HELD`
      : `SCANNING ACTUATOR BUS · CHANNEL ${of}`;
  }

  // No denominator, and the asymmetry with CHANNEL nn/06 above is the point:
  // the console knows a leg has six joints (components/console/joint-spec.ts is
  // its own spec sheet), and it does not know how many nodes a scan will walk —
  // that is the robot's tree, arriving one line at a time. Printing a total
  // here would mean hardcoding the simulator's walk list into the UI and
  // calling it knowledge.
  if (progress.walked > 0) {
    return `WALKING SUBSYSTEM TREE · NODE ${pad2(progress.walked)}`;
  }

  return "INITIALISING SCAN · AWAITING SUBSYSTEM TREE";
}

/** The one-word phase in the session header, beside the elapsed clock. */
export function scanPhaseWord(link: ScanLink, phase: "scanning" | "verdict"): string {
  if (link !== "open") return "HOLD";
  return phase === "verdict" ? "VERDICT" : "SCANNING";
}

/**
 * A stable-looking session id for the header.
 *
 * Deliberately client-side and deliberately not in the store: this identifies
 * *this console's view* of the scan, not the scan itself (the sim has no
 * session id on the wire), so a second console watching the same scan showing
 * a different id is correct rather than a bug. It exists because a diagnostic
 * board with no session handle looks like a mock-up.
 */
export function sessionTag(unitId: string, startedAtMs: number): string {
  let h = 0x811c9dc5;
  for (const s of `${unitId}:${Math.floor(startedAtMs)}`) {
    h = Math.imul(h ^ s.charCodeAt(0), 0x01000193);
  }
  const hex = (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}
