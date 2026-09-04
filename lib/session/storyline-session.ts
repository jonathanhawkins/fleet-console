import * as z from "zod/mini";
import { verdictReportSchema } from "@/lib/schema";

/**
 * What survives a page reload.
 *
 * Reloading used to throw the demo away without saying so: the storyline
 * restarted at zero while the alert you were reading kept its old raised-at
 * stamp, and the incident you had just produced — the entire point of the
 * golden path — vanished along with the section that held it. A reviewer's
 * most natural gesture ("let me watch that again") was the one that destroyed
 * the thing they wanted to watch.
 *
 * Two facts are kept, and they are kept together because either alone is a
 * lie. The **storyline position** puts the fleet back at the moment you left
 * it rather than at t=0. The **incident history** is then coherent: an
 * incident recorded at 1:40 belongs on a fleet that is at 1:40. Persisting the
 * history against a restarted sim would have been the worse bug — a service
 * record for a fault no robot currently has.
 *
 * `sessionStorage`, not `localStorage`: this is the state of one sitting with
 * one tab. Closing the tab ends the demo, which is the honest lifetime for
 * something that says "all data is simulated" on every page. Every access is
 * wrapped, because a private window can throw on the property itself, and a
 * demo that white-screens rather than losing its scroll position is a worse
 * trade than the one it was trying to make.
 */

const KEY = "fleet-console.session";

/** Time away is not story time: a tab reopened after lunch resumes, not skips. */
const MAX_RESUME_MS = 30 * 60 * 1000;

const incidentRecordSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  report: verdictReportSchema,
  acknowledged: z.array(z.string()),
  startedAt: z.optional(z.number()),
  channels: z.optional(
    z.array(
      z.object({
        joint: z.string(),
        wave: z.array(z.number()),
        ref: z.array(z.number()),
      }),
    ),
  ),
  calibration: z.optional(z.unknown()),
});

/**
 * The persisted blob, validated on the way back in.
 *
 * sessionStorage is a boundary like any other — the value is whatever was
 * there last, which may have been written by an older build or edited by hand
 * — so it gets the same treatment the wire gets: parse, and on failure behave
 * exactly as if there were nothing stored.
 */
const sessionSchema = z.object({
  version: z.literal(1),
  storylineMs: z.number().check(z.minimum(0)),
  incidents: z.array(incidentRecordSchema),
});

export type StorylineSession = z.infer<typeof sessionSchema>;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(): StorylineSession | null {
  const raw = (() => {
    try {
      return store()?.getItem(KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (raw === null) return null;

  try {
    const parsed = sessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function write(next: StorylineSession): void {
  try {
    store()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or unavailable quota costs the resume, nothing else.
  }
}

/**
 * Where the storyline should pick up, in ms, or 0 for a fresh run.
 *
 * Read once at transport construction. Clamped: a session restored from
 * yesterday would otherwise resume half an hour past the last storyline beat,
 * which is a fleet with nothing left to say.
 */
export function readStorylineResumeMs(): number {
  const session = read();
  if (session === null) return 0;
  return Math.min(session.storylineMs, MAX_RESUME_MS);
}

/** The incidents this session has produced, for the store to start from. */
export function readPersistedIncidents(): StorylineSession["incidents"] {
  return read()?.incidents ?? [];
}

/** Record the storyline clock without disturbing the incidents beside it. */
export function markStorylinePosition(storylineMs: number): void {
  const current = read();
  write({
    version: 1,
    storylineMs: Math.max(0, Math.round(storylineMs)),
    incidents: current?.incidents ?? [],
  });
}

/** Record the incidents without disturbing the clock beside them. */
export function markIncidents(incidents: unknown): void {
  const parsed = z.array(incidentRecordSchema).safeParse(incidents);
  if (!parsed.success) return;
  const current = read();
  write({
    version: 1,
    storylineMs: current?.storylineMs ?? 0,
    incidents: parsed.data,
  });
}

/**
 * Forget the sitting entirely.
 *
 * Called by the two controls that restart the story on purpose — the reset and
 * a chapter jump. Both put the sim back to a known point, and a resume offset
 * or an incident from the run they just replaced would contradict it.
 */
export function clearStorylineSession(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // Nothing to do: the next read fails closed and the demo starts fresh.
  }
}
