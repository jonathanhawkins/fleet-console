"use client";

import { type CohortIncident } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { ReportTable, ReportTableHead } from "../report-surface";

/**
 * The comparison the rollback was justified by, in numbers: the sentence
 * (`canaryLine`) is what an operator quotes, the table is what they check.
 * Rows are the store's own, suspect build first.
 */
export function CanaryTable({
  cohort,
  fleetSize,
}: {
  cohort: CohortIncident;
  fleetSize: number;
}) {
  if (cohort.canary.length === 0) return null;
  return (
    <div className="mt-5">
      <ReportTable measure="compare">
        <thead>
          <tr className="border-b border-line text-left">
            <ReportTableHead className="pr-4">Firmware</ReportTableHead>
            <ReportTableHead align="right" className="pr-4">
              Affected
            </ReportTableHead>
            <ReportTableHead align="right">Units on this build</ReportTableHead>
          </tr>
        </thead>
        <tbody>
          {cohort.canary.map((row) => {
            const suspect = row.fw === cohort.fw;
            return (
              <tr
                key={row.fw}
                data-canary={row.fw}
                className="border-b border-line last:border-b-0"
              >
                <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                  <span className="tnum">{row.fw}</span>
                  {suspect ? (
                    <span className="ml-2 text-label tracking-normal text-alert-ink">
                      suspect
                    </span>
                  ) : null}
                </th>
                <td
                  className={cn(
                    "py-2 pr-4 text-right tnum",
                    row.affected > 0 ? "text-alert-ink" : "text-ink",
                  )}
                >
                  {row.affected}
                </td>
                <td className="py-2 text-right tnum text-ink">{row.total}</td>
              </tr>
            );
          })}
        </tbody>
      </ReportTable>
      <p className="mt-2 max-w-[32rem] text-label tracking-normal text-ink-soft">
        Counted across <span className="tnum">{fleetSize}</span> units reporting firmware.
        Only alerts carrying this incident&rsquo;s signature count.
      </p>
    </div>
  );
}

/**
 * The one sentence stating what the comparison shows, derived from the canary
 * rows so it cannot drift from the table beside it.
 */
export function confirmedFleetSignal(cohort: CohortIncident): string {
  const suspect = cohort.canary.find((c) => c.fw === cohort.fw);
  const rest = cohort.canary.filter((c) => c.fw !== cohort.fw);
  const clean = rest.filter((c) => c.affected === 0);
  if (suspect === undefined) return "Firmware comparison is not on file.";
  const others =
    clean.length === rest.length
      ? `none of the ${rest.reduce((n, c) => n + c.total, 0)} units on other builds`
      : `${rest.reduce((n, c) => n + c.affected, 0)} of the ${rest.reduce((n, c) => n + c.total, 0)} units on other builds`;
  return `${suspect.affected} of ${suspect.total} units on ${suspect.fw} affected, ${others}.`;
}
