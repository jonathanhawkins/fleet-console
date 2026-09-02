"use client";

import { clockTime } from "../alert-lifecycle";
import { listUnits, refusalNote } from "../cohort-copy";
import { ReportFigure, ReportQuote } from "../report-surface";

/**
 * The update that did not happen. Written flat, and resting entirely on the
 * halt's receipt — the only artefact a prevented install leaves. The section
 * exists in every branch, including the ones where nothing was saved.
 */
export function PreventedBlock({
  prevented,
  refusal,
  rolledBack,
  sinceDetection,
  fw,
}: {
  prevented: readonly { unitId: string; fw: string; at: number; note: string }[];
  refusal: { reason: string; at: number } | null;
  rolledBack: number;
  sinceDetection?: number;
  /** The suspect build — what these units did NOT take. */
  fw: string;
}) {
  if (prevented.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-body text-ink">
          {refusal === null
            ? "No update was prevented — no halt was ordered on this incident."
            : "No update was prevented."}
        </p>
        {refusal === null ? null : (
          <>
            <p className="tnum text-small text-alert-ink">
              Halt refused {clockTime(refusal.at)} — {refusal.reason}
            </p>
            {refusalNote(refusal.reason) === null ? null : (
              <p className="text-small text-ink-soft">{refusalNote(refusal.reason)}</p>
            )}
          </>
        )}
      </div>
    );
  }

  const first = prevented[0]!;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-body text-ink">
          {listUnits(prevented.map((p) => p.unitId))} did not take{" "}
          <span className="tnum">{fw}</span>.
        </p>
        {/* The receipt itself, verbatim — never rebuilt from the parse. */}
        <ReportQuote
          className="mt-3"
          caption={
            <>
              Recorded by the rollout program at{" "}
              <span className="tnum">{clockTime(first.at)}</span>
            </>
          }
        >
          {prevented.map((p) => (
            <blockquote
              key={p.unitId}
              data-prevented={p.unitId}
              className="text-small text-ink"
            >
              {p.note}
            </blockquote>
          ))}
        </ReportQuote>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
        <ReportFigure label="Units rolled back" value={`${rolledBack}`} />
        <ReportFigure label="Updates prevented" value={`${prevented.length}`} />
        <ReportFigure
          label="Halted after detection"
          ms={sinceDetection}
          hint="the window the rollout could still widen in"
        />
      </div>
    </div>
  );
}
