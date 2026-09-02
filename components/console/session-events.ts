"use client";

import { type UnitStatus } from "@/lib/schema";
import { type AuditEntry, type AuditKind } from "@/lib/stores";
import { type SessionBeatKind, type UnitStatusHistory } from "./status-history";
import { unitStatusCopy } from "./unit-status";

/**
 * The session, as a list of things that happened.
 *
 * ## Three sources, one list, and who owns what
 *
 * This is the only place in the UI that knows where a beat came from. Below it
 * everything — the packer, the timeline, its ticks, its spoken description —
 * works on `SessionEvent[]` and would not notice if all three sources were
 * replaced tomorrow. That was the point of writing it as a seam, and it is now
 * carrying its first swap: `lib/stores/auditStore.ts` took over the action
 * beats.
 *
 * **State** — Attention, Alert, Nominal — comes from the status **spans**, not
 * from the audit log's `alert-raised`. Two reasons, and both are about the band
 * underneath the ticks. A tick and the segment it sits on must agree, and the
 * spans are what the segment is drawn from; and the audit log's `alert-raised`
 * does not carry severity, so it cannot tell Attention from Alert, while it
 * *also* has no entry at all for the beat that has no alert behind it — the
 * recovery. Spans cover both directions and colour-match the band by
 * construction.
 *
 * **Actions** — Acknowledged, Resolved, Diagnostic, Verdict, Safe sit — come
 * from the **audit log**, which is the single source for them and
 * the only one that has them at all. The band cannot express a thing an
 * operator *did*. This is also why later work needs no change
 * here: the moment alert-lifecycle wires `ackAlert`, its beat appears on this
 * timeline, because the store already logs it.
 *
 * **The console's own session** — the left edge, and the link dropping out from
 * under it — comes from status-history.ts. Nothing in `lib/stores` knows or
 * should know whether this browser's socket is up; that is the console's
 * business, and it is genuinely part of reading a strange trace ("there is a
 * hole here because we were not listening").
 */

export type SessionEventKind =
  | "start"
  | UnitStatus
  | SessionBeatKind
  | "diagnostic"
  | "verdict"
  | "acknowledged"
  | "resolved"
  | "command"
  | "command-failed";

export interface SessionEvent {
  id: string;
  ts: number;
  kind: SessionEventKind;
  /** Operator-space, sentence case, one or two words. */
  label: string;
}

const BEAT_LABEL: Record<SessionBeatKind, string> = {
  "link-lost": "Link lost",
  "link-restored": "Reconnected",
};

/**
 * Which audit kinds earn a tick, and what to call them.
 *
 * `alert-raised` and `escalation` are deliberately absent — the spans own state
 * (see above), and an escalation entry shares its timestamp *and* its ref with
 * the raise that caused it, so admitting both would draw two marks on one
 * moment. `command-complete` is absent for the same reason: it lands about four
 * seconds after `command-accepted`, and a timeline that ticked both would spend
 * two of its beats saying the operator pressed one button.
 */
const AUDIT_LABEL: Partial<
  Record<AuditKind, { kind: SessionEventKind; label?: string }>
> = {
  "alert-acked": { kind: "acknowledged", label: "Acknowledged" },
  resolution: { kind: "resolved", label: "Resolved" },
  "diag-start": { kind: "diagnostic", label: "Diagnostic" },
  "diag-verdict": { kind: "verdict", label: "Verdict" },
  // Label comes from the ref, so a command this file has never heard of still
  // gets its own name on the timeline rather than the word "Command".
  "command-accepted": { kind: "command" },
  "command-failed": { kind: "command-failed", label: "Refused" },
};

/* -------------------------------------------------------------------------
   one moment, one beat
   ------------------------------------------------------------------------- */

/**
 * How far apart two entries can be and still be the same act.
 *
 * The case this exists for is one effect closing every alert on a unit the
 * moment a diagnostic is archived (`useResolveOnIncident`, incident-banner.tsx)
 * — a synchronous loop, so its entries land within a millisecond of each other
 * and never further apart than a slow frame. Two seconds is that, with room for
 * a busy main thread, and is far short of anything an operator would read as
 * two separate decisions.
 */
export const COLLAPSE_WINDOW_MS = 2_000;

/**
 * Which kinds may collapse — and why the set has exactly one member.
 *
 * Collapsing is only honest where the plural sentence is *writable*: the row
 * has to say how many facts it stands for, in the same voice the single row
 * used. `resolution` qualifies because its summaries all open on the verb
 * ("Resolved — diagnostic incident logged"), so the count splices into the
 * store's own words rather than into a second copy table (audit-line.ts).
 *
 * Nothing else is in here on speculation. Two raises never share a line — their
 * summaries name different faults — and a kind joins this set the day someone
 * can both produce it twice in one instant and write its plural line, not
 * before: a generic "(×2)" bolted onto an arbitrary sentence is the console
 * admitting it does not know what it is counting.
 */
const COLLAPSIBLE: ReadonlySet<AuditKind> = new Set<AuditKind>(["resolution"]);

/** One row of the log, or one tick: an entry and the number it stands for. */
export interface AuditGroup {
  /** The earliest of the cluster — its id keys the row, its ts stamps it. */
  entry: AuditEntry;
  /** 1 for every ordinary line; 2+ where identical entries shared a moment. */
  count: number;
}

/**
 * Chronology → the beats a reader should see.
 *
 * The store is right to hold one resolution entry per alert: each closure has
 * its own ref and its own subject. The *reader* is right to see one line and
 * one tick, because the same sentence at the same second twice reads as a
 * stutter rather than as two alerts. This is where those two truths are
 * reconciled, at render, with nothing dropped from the record.
 *
 * Takes the log **oldest first**, which is the order it is read in, and merges
 * only into the group immediately before: a closure separated from its twin by
 * some other beat is not the same moment, and reaching past that beat to merge
 * would quietly reorder the record. Identity is (kind, summary) — the summary
 * carries the resolution's `via`, so a safe-sit closure and a diagnostic closure
 * landing together stay two lines, which is right; they are two sentences.
 *
 * Every entry survives in some group. This is a reading of the log, not a filter
 * on it: `groups.reduce((n, g) => n + g.count, 0)` is the entry count.
 */
export function groupAuditEntries(
  chronological: readonly AuditEntry[],
  windowMs = COLLAPSE_WINDOW_MS,
): AuditGroup[] {
  const groups: AuditGroup[] = [];
  for (const entry of chronological) {
    const open = groups[groups.length - 1];
    if (
      open &&
      COLLAPSIBLE.has(entry.kind) &&
      open.entry.kind === entry.kind &&
      open.entry.summary === entry.summary &&
      entry.ts - open.entry.ts <= windowMs
    ) {
      open.count += 1;
      continue;
    }
    groups.push({ entry, count: 1 });
  }
  return groups;
}

/**
 * `COMMAND_SAFE_SIT#3` → "Safe sit".
 *
 * The audit log's ref is `<COMMAND_NAME>#<seq>`, which is the wire's
 * vocabulary; operator space says it in words. Derived rather than looked up so
 * that the next command to exist appears here correctly without this file being
 * edited — the fallback is the raw name, never a lie.
 */
export function commandLabel(ref: string | undefined): string {
  const name = ref?.split("#")[0]?.replace(/^COMMAND_/, "");
  if (!name) return "Command";
  const words = name.toLowerCase().replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * Journal → ticks, oldest first.
 *
 * The opening span is not an event: it is the state the console found the unit
 * in, and a tick claiming "went to Attention" at t=0 would be inventing a
 * transition nobody witnessed. Anything dated before the session goes the same
 * way — including audit entries carrying a wire timestamp from before this
 * console connected, which the sim replays on every join.
 */
export function deriveSessionEvents(
  history: UnitStatusHistory,
  audit: readonly AuditEntry[] = [],
): SessionEvent[] {
  const events: SessionEvent[] = [
    { id: "start", ts: history.startedAt, kind: "start", label: "Session start" },
  ];

  for (let i = 1; i < history.spans.length; i += 1) {
    const span = history.spans[i];
    if (!span || span.from < history.startedAt) continue;
    events.push({
      id: `span-${span.from}-${span.status}`,
      ts: span.from,
      kind: span.status,
      label: unitStatusCopy(span.status),
    });
  }

  for (const beat of history.beats) {
    if (beat.ts < history.startedAt) continue;
    events.push({
      id: `beat-${beat.id}`,
      ts: beat.ts,
      kind: beat.kind,
      label: BEAT_LABEL[beat.kind],
    });
  }

  // Grouped first, oldest-first as the grouper requires (the store keeps the
  // log newest-first). Two alerts closing on one press is one beat — see
  // `groupAuditEntries` — and a timeline that ticked both would stack the word
  // "Resolved" on itself at the same pixel.
  for (const { entry } of groupAuditEntries([...audit].reverse())) {
    const mapped = AUDIT_LABEL[entry.kind];
    if (!mapped || entry.ts < history.startedAt) continue;
    events.push({
      id: entry.id,
      ts: entry.ts,
      kind: mapped.kind,
      label: mapped.label ?? commandLabel(entry.ref),
    });
  }

  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/* -------------------------------------------------------------------------
   Label placement
   ------------------------------------------------------------------------- */

/**
 * Two rows of labels and no more.
 *
 * One row cannot hold a scripted incident at 390 px — "Session start",
 * "Attention", "Alert", "Diagnostic" and "Verdict" inside forty seconds of a
 * ninety second session is about 240 px of type in about 90 px of track. Three
 * rows would fit more and would also turn a quiet audit strip into a stack of
 * type as tall as a card. Two is the compromise the beats actually need, and
 * anything that still does not fit keeps its tick and loses its word rather
 * than being dropped from the timeline.
 */
export const LABEL_LANES = 2;

/** Breathing room between two labels sharing a lane. */
const LANE_GAP = 8;

/**
 * Geist Sans at label size, averaged over the one- and two-word strings this
 * component actually prints.
 *
 * Estimated rather than measured. Measuring means laying out every label and
 * reading its box back inside a render that already runs once a second, to
 * settle a packing decision that only has to be approximately right — and being
 * a couple of pixels over gives a label a couple of pixels more air, which is
 * the harmless direction to be wrong in. A wildly proportional string (a very
 * long command name) simply gets placed conservatively.
 */
const CHAR_PX = 5.9;

export function estimateLabelWidth(label: string, charPx = CHAR_PX): number {
  return Math.ceil(label.length * charPx);
}

/**
 * `00:00:00` at label size in tabular figures — the second line of every label
 * box.
 *
 * A constant rather than a measurement of each string, because it is the same
 * eight glyphs on every tick and `tnum` guarantees they are the same width on
 * all of them. Estimated a hair generous for the same reason `CHAR_PX` is: a
 * box two pixels too wide gives its neighbour two pixels more air.
 */
export const TIME_W = 48;

/**
 * How wide a placed label actually is now that it carries its clock.
 *
 * The packer packs *boxes*, not words: the word sits over the time, so the box
 * is as wide as the wider of the two, and a short beat ("Verdict") is now as
 * wide as the timestamp beneath it. Exported because a caller that wants to
 * know where a label ends — the clamp at the right edge, a test — has to ask
 * the same question the packer asked.
 */
export function eventBoxWidth(label: string): number {
  return Math.max(estimateLabelWidth(label), TIME_W);
}

export interface PlacedEvent extends SessionEvent {
  /** Tick position along the track, 0–100. */
  pct: number;
  /** Label box left edge in px, already clamped into the track. */
  labelX: number;
  /** Label row, or -1 when there was no room and only the tick is drawn. */
  lane: number;
  /**
   * May the tick run down to its own word?
   *
   * False when the corridor is occupied: a tick in the second lane has to cross
   * the first lane to reach its label, and if a *different* beat's label is
   * sitting at that x the hairline draws straight through its type — which
   * reads as a struck-out word rather than as a leader line. The tick then
   * stops at the band and the pairing is carried by position and by the clock
   * printed under the word, which is what disambiguates them anyway.
   */
  descends: boolean;
}

interface Interval {
  from: number;
  to: number;
  lane: number;
}

/**
 * Place every tick, and as many labels as fit.
 *
 * Order matters and it is not chronological. Ticks are chronological; *labels*
 * are placed session-start first (it anchors the left edge and is the one beat
 * that is always true) and then newest-first, because a crowded timeline is a
 * timeline with an incident on it and the beats an operator needs to read are
 * the ones at the end — the verdict, the diagnostic, the escalation. Placing
 * chronologically would spend both lanes on the calm opening and drop the
 * conclusion.
 */
export function packEvents(
  events: SessionEvent[],
  width: number,
  start: number,
  end: number,
): PlacedEvent[] {
  const total = Math.max(1, end - start);
  const lanes: Interval[][] = Array.from({ length: LABEL_LANES }, () => []);
  const boxes: Interval[] = [];
  const placed = new Map<string, { labelX: number; lane: number }>();

  const order = events.length > 0 ? [events[0]!, ...events.slice(1).reverse()] : [];
  for (const event of order) {
    const w = eventBoxWidth(event.label);
    const centre = ((event.ts - start) / total) * width;
    const x = clamp(centre - w / 2, 0, Math.max(0, width - w));
    let lane = -1;
    for (let l = 0; l < LABEL_LANES; l += 1) {
      const row = lanes[l];
      if (!row) continue;
      if (row.every((i) => x + w + LANE_GAP <= i.from || x >= i.to + LANE_GAP)) {
        const box = { from: x, to: x + w, lane: l };
        row.push(box);
        boxes.push(box);
        lane = l;
        break;
      }
    }
    placed.set(event.id, { labelX: x, lane });
  }

  return events.map((event) => {
    const hit = placed.get(event.id);
    const lane = hit?.lane ?? -1;
    const centre = ((event.ts - start) / total) * width;
    return {
      ...event,
      pct: clamp(((event.ts - start) / total) * 100, 0, 100),
      labelX: hit?.labelX ?? 0,
      lane,
      // Only a tick reaching past the first lane can cross anybody, and it
      // crosses whatever box happens to sit at its own x.
      descends:
        lane <= 0 ||
        !boxes.some((b) => b.lane < lane && centre >= b.from && centre <= b.to),
    };
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "+1:07" — offset from the session's own start, which is the timeline's zero. */
export function offsetLabel(ts: number, start: number): string {
  const seconds = Math.max(0, Math.round((ts - start) / 1000));
  return `+${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------
   the quiet measures
   ------------------------------------------------------------------------- */

/**
 * "1h 33m" · "12m" — elapsed time, read at a glance.
 *
 * Deliberately coarser than `formatDuration` (alert-lifecycle.ts), which is the
 * right formatter for a row that is *counting*: an alert open for four minutes
 * says "4m 07s" because the seconds are still moving and the operator is
 * watching them. Nothing measured here is moving. These are settled spans
 * between two marks, printed once, and a bracket reading "93m 24s" spends its
 * width on a digit that changes nothing about what the reader does next.
 *
 * Rounded to the nearest minute, and the hour is taken from the *rounded*
 * minutes so 59.7 minutes reads "1h 00m" rather than "59m 42s" — the two
 * branches must not disagree about which side of the hour a span fell on.
 */
export function spanLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${`${minutes % 60}`.padStart(2, "0")}m`;
}

/**
 * Under this, a span is not worth measuring.
 *
 * The timeline already places both marks; a bracket between two beats forty
 * seconds apart adds a rule, a word and a row of height to say something the
 * two ticks sitting side by side had already said. The measures exist for the
 * case the ticks cannot express — the ninety-three minutes between an alert
 * being raised and anyone running a diagnostic, which on a band scaled to a
 * whole session is a gap the eye reads as "a while".
 */
export const MEASURE_MIN_MS = 60_000;

/** A span worth naming: two beats, the time between them, and its word. */
export interface SessionMeasure {
  id: string;
  from: SessionEvent;
  to: SessionEvent;
  ms: number;
  /** `spanLabel(ms)` — the coarse form. */
  label: string;
  /** Spoken form for the timeline's description. */
  spoken: string;
}

/**
 * The two spans an incident is actually judged on.
 *
 * **Trouble → diagnostic** is the operator's response time, and it is the one
 * the user could not read off the strip. Its opening beat is the state change
 * rather than an audit entry, because the band's spans are what own state here
 * (see `deriveSessionEvents`) — an amber or a red starting is the moment this
 * unit became somebody's problem.
 *
 * **Diagnostic → resolved** is how long the answer took once someone asked.
 *
 * Not a general "measure every adjacent pair" pass: a timeline with a bracket
 * under every gap is a timeline with a second axis, and the operator is then
 * reading a chart rather than glancing at a strip.
 */
const MEASURE_PAIRS: ReadonlyArray<{
  id: string;
  from: readonly SessionEventKind[];
  to: SessionEventKind;
  spoken: (label: string) => string;
}> = [
  {
    id: "response",
    from: ["amber", "red"],
    to: "diagnostic",
    spoken: (label) => `${label} from the alert to the diagnostic`,
  },
  {
    id: "diagnosis",
    from: ["diagnostic"],
    to: "resolved",
    spoken: (label) => `${label} from the diagnostic to the resolution`,
  },
];

/**
 * Which spans this session has, given the beats it produced.
 *
 * Both endpoints must exist — a measure is a bracket between two marks, and one
 * drawn to a beat that has not happened yet would be the console asserting an
 * elapsed time against an open end. Pure, and computed from `SessionEvent[]`
 * like everything else below the seam, so the same two brackets appear whether
 * the beats came from the band, the audit log or something that does not exist
 * yet.
 */
export function sessionMeasures(
  events: readonly SessionEvent[],
  minMs = MEASURE_MIN_MS,
): SessionMeasure[] {
  const measures: SessionMeasure[] = [];
  for (const pair of MEASURE_PAIRS) {
    const from = events.find((e) => pair.from.includes(e.kind));
    if (!from) continue;
    const to = events.find((e) => e.kind === pair.to && e.ts > from.ts);
    if (!to) continue;
    const ms = to.ts - from.ts;
    if (ms < minMs) continue;
    const label = spanLabel(ms);
    measures.push({ id: pair.id, from, to, ms, label, spoken: pair.spoken(label) });
  }
  return measures;
}
