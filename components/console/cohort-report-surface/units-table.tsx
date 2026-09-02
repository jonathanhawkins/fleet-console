"use client";

import { clockTime, formatDuration } from "../alert-lifecycle";
import { type CohortUnitRow } from "../cohort-report";
import { NotRecorded, ReportTable, ReportTableHead } from "../report-surface";

/** A time, or an honest gap where no journal recorded one. */
function Stamp({ ts }: { ts?: number }) {
  if (ts === undefined) return <NotRecorded />;
  return <>{clockTime(ts)}</>;
}

/** One row per member: firmware before → after, raised, cleared, open for. */
export function UnitsTable({ rows }: { rows: readonly CohortUnitRow[] }) {
  if (rows.length === 0) {
    return <p className="text-small text-ink-soft">No members are on file.</p>;
  }
  return (
    <ReportTable measure="ledger">
      <thead>
        <tr className="border-b border-line text-left">
          <ReportTableHead className="pr-4">Unit</ReportTableHead>
          <ReportTableHead className="pr-4">Firmware</ReportTableHead>
          <ReportTableHead align="right" className="pr-4">
            Raised
          </ReportTableHead>
          <ReportTableHead align="right" className="pr-4">
            Cleared
          </ReportTableHead>
          <ReportTableHead align="right">Open for</ReportTableHead>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.unitId}
            data-unit={row.unitId}
            className="border-b border-line last:border-b-0"
          >
            <th scope="row" className="py-2 pr-4 text-left tnum font-normal text-ink">
              {row.unitId}
            </th>
            {/* Before and after in one cell: the pair is the fact. */}
            <td className="py-2 pr-4 tnum text-ink-soft">
              <span className={row.restored ? "text-ink-soft" : "text-alert-ink"}>
                {row.fwBefore}
              </span>
              {row.restored ? (
                <>
                  <span aria-hidden> → </span>
                  <span className="sr-only"> restored to </span>
                  <span className="text-ink">{row.fwAfter}</span>
                </>
              ) : (
                <span className="ml-2 text-label tracking-normal text-alert-ink">
                  still on build
                </span>
              )}
            </td>
            <td className="py-2 pr-4 text-right tnum text-ink">
              <Stamp ts={row.raised} />
            </td>
            <td className="py-2 pr-4 text-right tnum text-ink">
              <Stamp ts={row.cleared} />
            </td>
            <td className="py-2 text-right tnum text-ink-soft">
              {/* The same spoken gap as the two cells before it. */}
              {row.openFor === undefined ? <NotRecorded /> : formatDuration(row.openFor)}
            </td>
          </tr>
        ))}
      </tbody>
    </ReportTable>
  );
}
