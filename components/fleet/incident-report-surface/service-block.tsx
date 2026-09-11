"use client";

import { serviceRequested } from "@/lib/diagnostics/service-request";
import { type IncidentRecord } from "@/lib/stores";
import { cn } from "@/lib/utils";
import {
  componentForJoint,
  componentLabel,
  SERVICE_DISCLAIMER,
  serviceDateLabel,
  serviceDueInDays,
  serviceRecord,
} from "../component-spec";
import { ReportSection } from "../report-surface";

/**
 * The part's own history, on the report about the part.
 *
 * This is the fact that turns a measurement into an explanation — a knee out of
 * envelope is a fault; a knee out of envelope two hundred and thirteen days
 * into a hundred and eighty day interval is a cause — and it is the same record
 * the part card shows, read from the same module so the two cannot disagree.
 */
export function ServiceBlock({ record, now }: { record: IncidentRecord; now: number }) {
  const part = componentForJoint(record.report.joint);
  if (!part) return null;

  const service = serviceRecord(part);
  const due = serviceDueInDays(service);
  const serviced = serviceDateLabel(service, now);
  const dispatched = serviceRequested(record.acknowledged);

  return (
    <ReportSection label="Service">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <p className="text-small text-ink">
          {componentLabel(part)} · last serviced{" "}
          <span className="tnum">{serviced ?? "—"}</span>
        </p>
        <span
          className={cn("tnum text-small", due < 0 ? "text-warn-ink" : "text-ink-soft")}
        >
          {due < 0 ? `${Math.abs(due)} days overdue` : `Due in ${due} days`}
        </span>
      </div>
      <p className="mt-1 text-small text-ink-soft">{service.note}</p>
      {dispatched ? (
        <p className="mt-3 text-small text-ink">Dispatch service recorded.</p>
      ) : null}
      <p className="mt-3 text-label tracking-normal text-ink-soft">
        {SERVICE_DISCLAIMER}
      </p>
    </ReportSection>
  );
}
