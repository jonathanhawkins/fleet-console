import { create } from "zustand";
import { type DiagEvent, type DiagEventMessage, type VerdictReport } from "@/lib/schema";
import { useAuditStore, type AuditEntry, OPERATOR } from "./auditStore";

/**
 * Incident store: the diagnostic session state machine plus the history of
 * completed incidents.
 *
 * idle ──beginDescent──▶ descending ──scan_start──▶ scanning
 * scanning ──walk/channel/flag──▶ scanning (accumulates)
 * scanning ──verdict──▶ verdict ──completeAscent──▶ idle (+ history entry)
 * any non-idle ──abortSession──▶ idle (nothing archived; mid-scan disconnect)
 *
 * Alongside the phase, and orthogonal to it, sits `watching` — whether the
 * operator is *in* machine space right now. `leaveSession()` / `watchSession()`
 * move it without touching the phase, which is what lets an operator step out
 * of a running scan and come back to it with the log and the board intact. It
 * is not a fifth phase: a scan that nobody is looking at is still scanning.
 *
 * `beginDescent` is UI-initiated (the operator pressed "Run diagnostic" —
 * the caller also sends RUN_DIAGNOSTIC on the transport). Everything after
 * that is driven by streamed diag_events, not timers (PRD §6).
 * Off-script events are ignored, with one pragmatic exception: `scan_start`
 * while idle opens a session anyway, so a page refreshed mid-scan (or a
 * second console) still renders the descent.
 *
 * **Replay is idempotent.** A transport that reconnects mid-scan is re-sent the
 * whole emitted prefix (sim/server.ts replays `activeDiagEvents()` to every
 * joining socket), so the same walk lines and channels arrive a second time on
 * a session that already has them. Appending blind would double the log and
 * the board; the reducer therefore admits each event once, keyed on its
 * natural identity — the walked path, the channel's joint — and treats `flag`
 * and `verdict` as restatements. That holds for redelivery in any order, which
 * a cursor over the prefix would not.
 *
 * The assumption it rests on: within one scan a path is walked at most once and
 * a joint reports at most one channel. Both are properties of the scan
 * choreography (sim/engine.ts `DIAG_WALK_PATHS` is a set; channels are one per
 * joint in JOINTS order) and both are asserted in sim/diagnostics.test.ts. A
 * future scan that genuinely revisits a node would need a sequence number on
 * the wire rather than a looser reducer here.
 */

export type DiagPhase = "idle" | "descending" | "scanning" | "verdict";

export interface DiagChannel {
  joint: string;
  wave: number[];
  ref: number[];
}

export type DiagFlag = Extract<DiagEvent, { k: "flag" }>;

/**
 * The re-measured channel a completed RECALIBRATE JOINT produced —
 * the same shape as a scanned channel plus the sim's judgement of whether the
 * correction cleared the fault.
 *
 * It is stored beside `channels` rather than replacing the subject channel in
 * it. A record whose evidence had been overwritten by the fix could no longer
 * show what was wrong, only what is left, and "1.32× reference" means nothing
 * to a reader who never saw the 1.75× it came down from. Both traces are the
 * evidence; the pair is the argument.
 */
export type DiagCalibration = Extract<DiagEvent, { k: "recalibration" }>;

export interface DiagSession {
  unitId: string;
  /**
   * Epoch ms at which this console opened the session — the operator's press,
   * or the first replayed event for a scan it adopted.
   *
   * It lives here rather than in the machine-space stage because the stage no
   * longer outlives the session: an operator can leave a running scan and come
   * back to it (see `watching`), and a session id and an elapsed clock that
   * restarted on re-entry would be the console claiming the scan began when the
   * operator looked at it. The stage still keeps its own `performance.now()`
   * for the wipe — that one *is* about the animation, and it is right for it to
   * start again each time the surface travels.
   */
  startedAt: number;
  walkLines: string[];
  channels: DiagChannel[];
  flag: DiagFlag | null;
  report: VerdictReport | null;
  /**
   * Recommendations the operator pressed on the verdict card, in press order.
   *
   * They are acknowledgements, not commands: this console does not drive a
   * robot, and a button that claimed to disable a joint would be the one thing
   * in the demo pretending to be real. What they do is enter the incident
   * record, which is what an ops tool actually owes you — proof of what was
   * decided, attached to the diagnosis that prompted it.
   *
   * Two of them still work exactly that way. "Command safe sit" and
   * "Recalibrate joint" are executed on the unit instead
   * and are recorded here on confirm, so the record says the operator acted on
   * *that* line of the report either way — what differs is whether a robot
   * moved, which the command store and this field's `calibration` sibling are
   * the witnesses for.
   */
  acknowledged: string[];
  /** The re-measure, once a recalibration has completed; null before. */
  calibration: DiagCalibration | null;
}

export interface IncidentRecord {
  id: string;
  unitId: string;
  report: VerdictReport;
  /** Recommendations acknowledged before the operator ascended. */
  acknowledged: string[];
  /**
   * The session clock the verdict card's press times are keyed by
   * (components/machine/safe-sit-copy.ts) — without it a report can list
   * *what* an operator recorded but not *when*.
   */
  startedAt?: number;
  /**
   * The per-joint traces the verdict drew its evidence from.
   *
   * Archived with the record because the finding alone is not a record: a
   * service report whose evidence section says "the scan found a gain anomaly,
   * take our word for it" is the weakest page in the product. The incident
   * report's RMS/gain table and its wave-vs-reference exhibits are drawn from
   * these.
   *
   * Both fields are optional so a record without them — archived before they
   * rode the record, or from a scan that produced no channels — stays
   * representable, and the report renders "not on file" rather than a
   * plausible-looking exhibit nobody measured.
   */
  channels?: DiagChannel[];
  /**
   * The recalibration result, when one was performed before the operator
   * ascended. Optional like `channels` and for the same reason: an incident
   * where nobody tried the cheap rung must be representable as one, not as one
   * whose calibration silently reads as a failure.
   */
  calibration?: DiagCalibration;
}

/**
 * The session an exit is carrying off screen, and the phase it ended in.
 *
 * See {@link IncidentState.exiting}.
 */
export interface DepartingSession {
  session: DiagSession;
  phase: DiagPhase;
}

export interface IncidentState {
  phase: DiagPhase;
  session: DiagSession | null;
  /**
   * The session that has ended but is still on screen.
   *
   * `completeAscent()` and `abortSession()` destroy a session in the same
   * commit that starts an animation the surface has to outlive — the board
   * fades, then the wipe carries black back down, ~250 ms after the store has
   * already moved on. For that window there are two answers to "what scan is
   * this", and they are both correct: the store holds none, and the surface is
   * showing the one it is leaving with.
   *
   * That fact used to be latched three times over, once per surface that
   * noticed it — a ref in the stage, a context under it, and the gate's mount
   * flag. Latching it per-surface is what let `selectSessionEventCount` return
   * 0 mid-exit and print LINK RESTORED over a finished scan: an input nobody
   * had remembered to latch. So it is modelled once, here, additively:
   * `phase`, `session` and `watching` keep meaning exactly what they meant —
   * the *live* session and nothing else — and this holds the departing one
   * beside them. Read it through {@link selectShownSession} /
   * {@link selectShownPhase}; write it never, except through the transitions
   * below.
   *
   * **Only machine space may read through it.** The unit page underneath is
   * coming back into view during those 250 ms and has to be honest about a
   * console with no diagnostic running: a banner reading the snapshot would
   * say "Diagnostic in progress" over a scan that has already been archived.
   * Everything outside the departing surface reads `phase` / `session`.
   *
   * **Written only when a surface is actually showing the session** (see
   * `isShown`), and cleared by every transition that opens or re-enters one —
   * a new session is never a departing one. The surface that owns the exit
   * clears it with {@link dismissExit}; a surface torn down hard (the operator
   * navigates mid-exit) never gets to, which is why the gate also clears it on
   * unmount. A ref died with its component and needed none of that; a store
   * field does.
   */
  exiting: DepartingSession | null;
  /**
   * Is the operator in machine space for this session?
   *
   * The session and the *view* of it are two different facts, and this is the
   * one the console owns. A scan is not cancellable — the sim is executing the
   * sequence and an abort here would hide it rather than stop it — but it is
   * leaveable: CLOSE mid-scan ascends, the overlay unmounts, and the session
   * keeps accumulating events into `session` exactly as before. `watching` is
   * what tells the descent overlay to stay down, and `watchSession()` is what
   * sends the operator back into a scan that has been running without them.
   *
   * Store state rather than component state, for the reason minimize is *not*
   * (see verdict-card.tsx): minimize is one panel's business inside one
   * surface, whereas this must survive the overlay unmounting, must survive the
   * operator walking back to the fleet page and returning, and has to be
   * agreed on by two subtrees that never meet — the overlay and the unit
   * banner offering "View scan".
   *
   * Meaningless while idle, and reset with every session: opening one starts
   * the operator inside it, whether they pressed the button or the scan was
   * adopted from the wire on a mid-scan reload.
   */
  watching: boolean;
  /** Completed incidents, newest first. */
  history: IncidentRecord[];

  /** Operator pressed "Run diagnostic". Valid from idle only; no-op otherwise. */
  beginDescent(unitId: string): void;
  /** Feed every diag_event message here (bindTransport does). */
  applyDiagEvent(msg: DiagEventMessage): void;
  /**
   * Record that the operator acknowledged one of the verdict's
   * recommendations. Valid in the verdict phase only; pressing twice is a
   * no-op rather than a second entry.
   */
  acknowledgeRecommendation(action: string): void;
  /**
   * Verdict acknowledged, ascend: archive the session — verdict,
   * acknowledgements, and the evidence that produced it (`channels`, plus the
   * `startedAt` clock) — and return to idle.
   */
  completeAscent(): void;
  /**
   * Leave machine space without ending the scan (the CLOSE control, Escape).
   *
   * The session is untouched: events keep arriving, the log and the board keep
   * growing, and the unit page shows its "Diagnostic in progress" state with a
   * way back in. This is not `abortSession` and must never be confused with it
   * — one is the operator looking away, the other is throwing the scan out.
   */
  leaveSession(): void;
  /** Go back into a session that has been running without the operator. */
  watchSession(): void;
  /** Bail out of a session (disconnect, cancel): back to idle, nothing archived. */
  abortSession(): void;
  /**
   * The departing surface has finished leaving: drop {@link IncidentState.exiting}.
   *
   * Called by the gate when the exit animation completes, and again when the
   * gate itself unmounts — the second is the collection the first cannot do,
   * for a surface that was navigated away from mid-exit. Idempotent, and a
   * no-op when there is nothing departing, so both callers can be unconditional.
   */
  dismissExit(): void;
  reset(): void;
}

/**
 * Is a surface currently showing this session? — the condition under which an
 * exit is a thing that has to be animated at all.
 *
 * The same three facts the gate's `active` is built from, minus the unit id it
 * cannot know here (descent-overlay.tsx). It is the guard on writing
 * `exiting`, and it is what keeps the snapshot from being stranded by the
 * transitions no surface ever sees: a transport that aborts a session while
 * the operator is on the fleet page, or during `descending`, when the stage
 * has not mounted and the scan has not started.
 */
const isShown = (s: IncidentState): boolean =>
  s.watching && (s.phase === "scanning" || s.phase === "verdict");

const freshSession = (unitId: string): DiagSession => ({
  unitId,
  startedAt: Date.now(),
  walkLines: [],
  channels: [],
  flag: null,
  report: null,
  acknowledged: [],
  calibration: null,
});

export const useIncidentStore = create<IncidentState>()((set) => ({
  phase: "idle",
  session: null,
  exiting: null,
  watching: false,
  history: [],

  beginDescent: (unitId) =>
    set((s) => {
      if (s.phase !== "idle") return s;
      // A new session is never a departing one: whatever was still leaving is
      // superseded by this, and a stage that opens on it starts from the store.
      return {
        phase: "descending",
        session: freshSession(unitId),
        exiting: null,
        watching: true,
      };
    }),

  applyDiagEvent: (msg) => {
    // Audit entries ride the same admission logic that dedupes replay: a beat
    // the reducer ignores logs nothing, so the session log records each scan
    // and each verdict exactly once.
    const audits: Array<Omit<AuditEntry, "id">> = [];

    set((s) => {
      const ev = msg.ev;

      if (ev.k === "scan_start") {
        if (s.phase === "descending" && s.session?.unitId === msg.unitId) {
          audits.push({
            ts: s.session.startedAt,
            kind: "diag-start",
            actor: OPERATOR,
            unitId: msg.unitId,
            summary: "Diagnostic scan started",
          });
          return { phase: "scanning" };
        }
        if (s.phase === "idle") {
          // Late joiner: adopt the in-flight scan. `watching: true` because the
          // only way to arrive here is a console that has just loaded — a
          // refresh mid-scan, or a second console — and the honest thing for it
          // to render is the scan that is actually running.
          const session = freshSession(msg.unitId);
          audits.push({
            ts: session.startedAt,
            kind: "diag-start",
            actor: OPERATOR,
            unitId: msg.unitId,
            summary: "Diagnostic scan started",
          });
          // Same rule as `beginDescent`: this is a session opening, so nothing
          // is departing any more.
          return { phase: "scanning", session, exiting: null, watching: true };
        }
        return s;
      }

      /**
       * The recalibration result is the one diag event that belongs to a scan
       * that is already OVER: the operator recalibrated off the
       * verdict card, so it is admitted in the verdict phase and in no other.
       *
       * That is a real gate, not a formality. A re-measured channel with no
       * standing verdict beside it is a number with nothing to compare it to,
       * and the card's whole claim — this came down from that — would be the
       * console asserting a before it never saw. First write wins, like every
       * other beat here, so a replayed complete restates nothing.
       *
       * The joint is part of that gate for the same reason the phase is
       *. "The fault cleared without a visit" is a sentence about the
       * flagged joint, and downstream the two surfaces that render the
       * *exhibit* check which joint was measured while the two that render the
       * *prose* read the calibration straight — so a re-measure of some other
       * joint, admitted here, would file a report claiming the fault cleared
       * from a measurement of a different actuator, over an exhibit correctly
       * showing the original untouched. Held here rather than patched at four
       * call sites: the record cannot contain a calibration that is not about
       * its own subject, so no consumer has to know that it could.
       */
      if (ev.k === "recalibration") {
        if (s.phase !== "verdict" || !s.session || s.session.unitId !== msg.unitId)
          return s;
        if (s.session.report?.joint !== ev.joint) return s;
        if (s.session.calibration !== null) return s;
        audits.push({
          ts: Date.now(),
          kind: "diag-recalibrated",
          unitId: msg.unitId,
          summary:
            ev.outcome === "cleared"
              ? `${ev.joint} recalibrated: channel restored to reference`
              : `${ev.joint} recalibrated: partial correction, residual anomaly`,
          ref: `recal-${msg.unitId}-${s.session.startedAt}`,
        });
        return { session: { ...s.session, calibration: ev } };
      }

      // every other event only advances the session it belongs to
      if (s.phase !== "scanning" || !s.session || s.session.unitId !== msg.unitId)
        return s;

      switch (ev.k) {
        case "walk":
          // Replayed line: the session already holds it. Returning `s` by
          // identity is what keeps a reconnect free — no new session object,
          // so nothing subscribed to the log re-renders.
          if (s.session.walkLines.includes(ev.path)) return s;
          return {
            session: { ...s.session, walkLines: [...s.session.walkLines, ev.path] },
          };
        case "channel":
          if (s.session.channels.some((c) => c.joint === ev.joint)) return s;
          return {
            session: {
              ...s.session,
              channels: [
                ...s.session.channels,
                { joint: ev.joint, wave: ev.wave, ref: ev.ref },
              ],
            },
          };
        case "flag":
          if (s.session.flag !== null) return s;
          return { session: { ...s.session, flag: ev } };
        case "verdict":
          // ref pre-computes the id `completeAscent` will give the history
          // record, so audit rows can link to the incident they became.
          audits.push({
            ts: ev.report.ts,
            kind: "diag-verdict",
            unitId: msg.unitId,
            summary: ev.report.summary,
            ref: `inc-${ev.report.unitId}-${ev.report.ts}`,
          });
          return { phase: "verdict", session: { ...s.session, report: ev.report } };
      }
    });

    const audit = useAuditStore.getState();
    for (const entry of audits) audit.append(entry);
  },

  acknowledgeRecommendation: (action) =>
    set((s) => {
      if (s.phase !== "verdict" || !s.session) return s;
      if (s.session.acknowledged.includes(action)) return s;
      return {
        session: { ...s.session, acknowledged: [...s.session.acknowledged, action] },
      };
    }),

  completeAscent: () =>
    set((s) => {
      if (s.phase !== "verdict" || !s.session?.report) return s;
      const report = s.session.report;
      const record: IncidentRecord = {
        id: `inc-${report.unitId}-${report.ts}`,
        unitId: report.unitId,
        report,
        acknowledged: s.session.acknowledged,
        startedAt: s.session.startedAt,
        channels: s.session.channels,
        ...(s.session.calibration ? { calibration: s.session.calibration } : {}),
      };
      return {
        phase: "idle",
        session: null,
        // What the operator is watching leave. `phase` is "verdict" by the
        // guard above, so the surface goes on saying VERDICT rather than
        // reverting to SCANNING on its way out.
        exiting: isShown(s) ? { session: s.session, phase: s.phase } : null,
        watching: false,
        history: [record, ...s.history],
      };
    }),

  /**
   * Deliberately does not write `exiting`, and that is the whole difference
   * between this and the two above: nothing is departing. The session stays
   * alive in the store, keeps accumulating, and a surface still animating its
   * way out renders it *live* through that exit — a walk line that lands during
   * the ascent is a real line of a real scan, and printing it is honest. The
   * snapshot exists to preserve a session that no longer exists; there is no
   * such session here.
   */
  leaveSession: () =>
    set((s) => (s.phase === "idle" || !s.watching ? s : { watching: false })),

  // Re-entry mounts a fresh stage on a live session, so anything held for a
  // previous exit is done (and its stage is gone).
  watchSession: () =>
    set((s) =>
      s.phase === "idle" || s.watching ? s : { watching: true, exiting: null },
    ),

  abortSession: () =>
    set((s) =>
      s.phase === "idle"
        ? s
        : {
            phase: "idle",
            session: null,
            exiting:
              isShown(s) && s.session ? { session: s.session, phase: s.phase } : null,
            watching: false,
          },
    ),

  dismissExit: () => set((s) => (s.exiting === null ? s : { exiting: null })),

  reset: () =>
    set({ phase: "idle", session: null, exiting: null, watching: false, history: [] }),
}));

// ---------------------------------------------------------------------------
// narrow selectors

export const selectDiagPhase = (s: IncidentState): DiagPhase => s.phase;
/** Is the operator in machine space for the open session? */
export const selectDiagWatching = (s: IncidentState): boolean => s.watching;

/**
 * Is a finished session still on screen? A primitive, so a subscriber to this
 * alone re-renders twice per exit and not once per event.
 */
export const selectExiting = (s: IncidentState): boolean => s.exiting !== null;

/**
 * The session *machine space* is showing: the live one, or — for the length of
 * an exit — the one it is leaving with.
 *
 * The two selectors below are the only sanctioned readers of `exiting`, and
 * they belong to the departing surface and nothing else. Read them from a
 * component on the operator page and it will spend the ascent describing a
 * diagnostic the store has already archived, which is the same bug as before
 * with the pages swapped. See the note on {@link IncidentState.exiting}.
 *
 * Returns a reference held by the store, so the identity is stable across the
 * whole exit and a panel subscribed to it does not re-render because of it.
 */
export const selectShownSession = (s: IncidentState): DiagSession | null =>
  s.session ?? s.exiting?.session ?? null;

/**
 * The phase machine space is showing. `idle` never reaches the surface: the
 * exit renders the phase the session ended in, so a verdict leaves as a
 * verdict rather than reverting to SCANNING for its last 250 ms.
 */
export const selectShownPhase = (s: IncidentState): DiagPhase =>
  s.session === null && s.exiting !== null ? s.exiting.phase : s.phase;
/**
 * History for one unit's drill-in page. Returns a fresh array — wrap with
 * `useShallow` (zustand/react/shallow) when subscribing from React.
 */
export const selectUnitHistory =
  (unitId: string) =>
  (s: IncidentState): IncidentRecord[] =>
    s.history.filter((r) => r.unitId === unitId);
