"use client";

import { getUnitBuffers, useFleetStore, type TelemetryMetric } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { envelope, METRIC_SPEC, useNow } from "@/components/console";
import { breachedRecently, stripTone, type StripTone } from "./strip-tone";

// The readout's frame, shared by the live numeral and the cursor readout so
// the em-dash and the first reading are the same `<span>`: React patches its
// class, and the numeral inks up over `--dur-micro` once per box per session.
export const READOUT =
  "tnum text-small transition-colors duration-[var(--dur-micro)] ease-console";

export const TONE_CLASS: Record<StripTone, string> = {
  ink: "text-ink",
  warn: "text-warn-ink",
  alert: "text-alert-ink",
};

// The live numeral, on the app's one-second clock: the ring is read
// non-reactively and the ten batches between two ticks cost nothing. Rendering
// it from the telemetry version would re-render the subtree per batch.
export function StripValue({
  unitId,
  joint,
  metric,
}: {
  unitId: string;
  joint: string;
  metric: TelemetryMetric;
}) {
  const now = useNow();
  const spec = METRIC_SPEC[metric];
  const env = envelope(joint, metric);
  const series = getUnitBuffers(unitId)?.joints.get(joint)?.[metric];
  const value = now === 0 ? undefined : series?.last();

  if (value === undefined || !series) {
    return (
      <span className={cn(READOUT, "text-ink-muted")}>
        <span aria-hidden>—</span>
        <span className="sr-only">No reading yet</span>
      </span>
    );
  }

  const status = useFleetStore.getState().units[unitId]?.status;
  const tone = stripTone(breachedRecently(series, env.healthy), status);

  return (
    <span className={cn(READOUT, TONE_CLASS[tone])}>
      {value.toFixed(spec.precision)}
      <span className="ml-1 text-ink-soft">{spec.unit}</span>
    </span>
  );
}
