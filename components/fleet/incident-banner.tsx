"use client";

import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { criticalSpring, springSettled, type SpringSpec } from "@/lib/motion";
import { type Alert, type VerdictReport } from "@/lib/schema";
import {
  selectAlertMeta,
  selectAlerts,
  selectUnit,
  selectUnitFirstRaisedAt,
  selectUnitHistory,
  useFleetStore,
  useIncidentStore,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { clockTime, durationSince } from "./alert-lifecycle";
import { preloadMachineSpace } from "./descent-overlay";
import {
  jointLabel,
  registerFrame,
  SectionLabel,
  unitStatusChip,
  unitStatusCopy,
  useNow,
  usePrefersReducedMotion,
} from "@/components/console";
import {
  RunDiagnosticButton,
  useUnitDiagnostic,
  ViewDiagnosticButton,
} from "./run-diagnostic";

/**
 * The one loud object in operator space: one tinted surface, one sentence,
 * the product's single dark pill. It exists only while a unit needs something.
 */

/** Strip the wire's house-name prefix on the unit's own page. */
export function incidentHeadline(message: string, unitName: string): string {
  const prefix = `${unitName}: `;
  const body = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/** The verdict in the page's voice, from the report's fields, not its `summary`. */
export function verdictLine(report: VerdictReport): string {
  // The clean scan has no joint or component to name.
  if (report.anomaly === "none") return "Diagnostic complete — no anomaly.";
  const component = report.component
    .replace(/_/g, " ")
    .replace(/\b([A-Z])(\d+)\b/g, "$1-$2");
  return `${jointLabel(report.joint)} ${component}: ${report.anomaly} anomaly.`;
}

const TONE_SURFACE = {
  warn: "border-warn/35 bg-warn-tint",
  alert: "border-alert/35 bg-alert-tint",
  nominal: "border-line bg-surface",
} as const;

/* ---------------------------------------------------------------------------
   the arrival: the wrapper travels to the banner's measured height on a
   critically damped spring while the contents fade in behind its leading edge
--------------------------------------------------------------------------- */

/** The arrival's natural period — 166 ms to 95 %, inside the micro band. */
const REVEAL_RESPONSE_S = 0.22;

/** Marks the content row so the reveal fades it in behind the leading edge. */
const BODY_ATTR = "data-banner-body";

/** Where the contents fade, as fractions of the travel; the edge stays ahead. */
const FADE_FROM = 0.45;
const FADE_TO = 0.95;

/** Measure before paint on the client; do not exist on the server. */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

interface RevealFlight {
  spec: SpringSpec;
  /** The natural height the fade and the gap are measured against. */
  span: number;
  /** Frame-loop time of the first sample; -1 until that frame arrives. */
  startedAt: number;
  stop: () => void;
  onSettled: (() => void) | null;
}

/** The height this element would have with nothing written on it. */
function naturalHeight(el: HTMLElement): number {
  const inline = el.style.height;
  if (inline) el.style.height = "";
  const height = el.getBoundingClientRect().height;
  if (inline) el.style.height = inline;
  return height;
}

/** The column's row gap, which a zero-height wrapper still claims in full. */
function rowGapOf(el: HTMLElement): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const gap = Number.parseFloat(getComputedStyle(parent).rowGap);
  return Number.isFinite(gap) ? gap : 0;
}

function BannerReveal({ children }: { children: React.ReactElement | null }) {
  const reducedMotion = usePrefersReducedMotion();
  const present = children !== null;

  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const flightRef = React.useRef<RevealFlight | null>(null);
  /** The height on screen this frame, and the speed it is moving at. */
  const shownRef = React.useRef(0);
  const velocityRef = React.useRef(0);
  /** True between a flight's first frame and its settle; survives interrupts. */
  const flyingRef = React.useRef(false);
  const gapRef = React.useRef(0);
  /** False until this component has committed once. */
  const primedRef = React.useRef(false);

  // The last thing the banner said, held so the collapse has something to play.
  const lastRef = React.useRef<React.ReactElement | null>(null);
  if (children !== null) lastRef.current = children;

  // `open` leads `present` on the way in and lags it on the way out; adjusted
  // during render so the arrival lands in the store's commit.
  const [open, setOpen] = React.useState(present);
  if (present && !open) setOpen(true);

  useIsomorphicLayoutEffect(() => {
    const el = wrapRef.current;
    const primed = primedRef.current;
    primedRef.current = true;
    if (!el) return;

    const body = el.querySelector<HTMLElement>(`[${BODY_ATTR}]`);

    const write = (height: number, span: number) => {
      shownRef.current = height;
      el.style.height = `${height}px`;
      const p = span > 0 ? Math.min(1, Math.max(0, height / span)) : 1;
      el.style.marginTop = `${-(1 - p) * gapRef.current}px`;
      if (body) {
        const fade = (p - FADE_FROM) / (FADE_TO - FADE_FROM);
        body.style.opacity = `${Math.min(1, Math.max(0, fade))}`;
      }
    };

    const release = () => {
      el.style.height = "";
      el.style.marginTop = "";
      el.style.overflow = "";
      if (body) body.style.opacity = "";
      flyingRef.current = false;
      velocityRef.current = 0;
    };

    // Arrived WITH the page: nothing to announce. Reduced motion takes the
    // same branch — the CSS clamp cannot reach a rAF spring.
    if (reducedMotion || (!primed && present)) {
      release();
      return;
    }

    // Measured now, not remembered; an interrupted flight continues from the
    // pixel and speed on screen.
    const span = naturalHeight(el);
    const to = present ? span : 0;
    const from = flyingRef.current ? shownRef.current : present ? 0 : span;
    if (to === from || span <= 0) return;

    gapRef.current = rowGapOf(el);
    el.style.overflow = "hidden";
    write(from, span);

    const spec: SpringSpec = {
      from,
      to,
      velocity: velocityRef.current,
      response: REVEAL_RESPONSE_S,
    };
    flyingRef.current = true;

    const stop = registerFrame((now) => {
      const flight = flightRef.current;
      if (!flight) return;
      // The origin is the first sampled frame, not the commit: a rAF timestamp
      // can be ahead of the commit's clock and the first samples jump back.
      if (flight.startedAt < 0) flight.startedAt = now;
      const sample = criticalSpring(flight.spec, (now - flight.startedAt) / 1000);
      if (springSettled(sample, flight.spec.to)) {
        flight.stop();
        flightRef.current = null;
        velocityRef.current = 0;
        // A settled arrival hands the box back to the layout.
        if (flight.spec.to > 0) release();
        else flyingRef.current = false;
        flight.onSettled?.();
        return;
      }
      write(sample.value, flight.span);
      velocityRef.current = sample.velocity;
    });

    flightRef.current = {
      spec,
      span,
      startedAt: -1,
      stop,
      // The wrapper leaves the DOM only once the space it held has closed.
      onSettled: present ? null : () => setOpen(false),
    };

    return () => {
      flightRef.current?.stop();
      flightRef.current = null;
    };
  }, [present, open, reducedMotion]);

  if (!open) return null;

  // `inert` while closing: the departing banner's button must not be a second
  // "Run diagnostic" under the cursor.
  return (
    <div
      ref={wrapRef}
      data-slot="incident-reveal"
      className="rounded-xl"
      inert={!present}
    >
      {present ? children : lastRef.current}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   the one place a diagnostic closes the alert that prompted it
--------------------------------------------------------------------------- */

/**
 * Verdict archived → `resolveAlert`; the whole of that wiring. There is no
 * RESOLVE on the wire. Reads the alert list non-reactively, so it fires once
 * per incident and never retroactively closes a later alert.
 */
function useResolveOnIncident(unitId: string, incidentId: string | undefined): void {
  React.useEffect(() => {
    if (incidentId === undefined) return;
    const fleet = useFleetStore.getState();
    for (const alert of fleet.alerts) {
      if (alert.unitId !== unitId) continue;
      fleet.resolveAlert(alert.id, { via: "incident", ref: incidentId });
    }
  }, [unitId, incidentId]);
}

export interface IncidentBannerProps extends Omit<
  React.ComponentPropsWithoutRef<"section">,
  "children"
> {
  unitId: string;
}

export function IncidentBanner({ className, unitId, ...props }: IncidentBannerProps) {
  const unit = useFleetStore(selectUnit(unitId));
  const alerts = useFleetStore(selectAlerts);
  // Derived once (run-diagnostic.tsx) so the identity header and this banner
  // cannot both offer the diagnostic.
  const { state, viewable, report, archived } = useUnitDiagnostic(unitId);
  const running = state === "running";
  const complete = state === "complete";
  const resolved = state === "resolved";

  // The newest alert is the headline; read before the early return for the hooks.
  const latest: Alert | undefined = alerts.find((a) => a.unitId === unitId);
  const acked = useFleetStore(selectAlertMeta(latest?.id ?? ""))?.ackedAt !== undefined;

  // The OLDEST standing alert dates the trouble; escalation must not restart the clock.
  const firstRaisedAt = useFleetStore(selectUnitFirstRaisedAt(unitId));
  const now = useNow();

  // The incident that closes this unit's alerts out, if there is one.
  const history = useIncidentStore(useShallow(selectUnitHistory(unitId)));
  const record = history[0];
  useResolveOnIncident(
    unitId,
    record && record.report.anomaly !== "none" ? record.id : undefined,
  );

  // Warm the machine-space chunk: the descent must not wait on a round trip.
  React.useEffect(() => {
    preloadMachineSpace();
  }, []);

  // Nothing to say — through the reveal, so a banner closes rather than disappears.
  if (!unit || state === "none") return <BannerReveal>{null}</BannerReveal>;

  // A diagnosed incident is amber whatever the unit's status.
  const tone = resolved ? "warn" : unitStatusChip(unit.status);
  const incident = latest ? incidentHeadline(latest.message, unit.name) : null;
  /** A verdict that found nothing has no part to name and nothing to dispatch. */
  const clean = complete && report?.anomaly === "none";

  const headline = running
    ? "Diagnostic in progress"
    : complete
      ? clean
        ? "Diagnostic complete — no anomaly"
        : "Diagnostic complete"
      : resolved
        ? "Diagnostic complete — service recommended"
        : (incident ?? `${unit.name} needs attention`);

  // In the working states the incident line demotes to the subhead.
  let detail: string | null = null;
  if (running) detail = incident;
  else if (complete) detail = clean ? null : report ? verdictLine(report) : incident;
  else if (resolved) detail = archived ? verdictLine(archived) : incident;

  // Shown only while undiagnosed; ticks off the shared 1 s clock, never a version counter.
  const openFor = state === "raised" ? durationSince(firstRaisedAt, now) : null;

  return (
    <BannerReveal>
      <section
        data-slot="incident-banner"
        data-status={tone}
        data-phase={
          running ? "running" : complete ? "complete" : resolved ? "resolved" : "raised"
        }
        aria-labelledby="incident-headline"
        className={cn(
          "relative overflow-hidden rounded-xl border p-5 sm:p-6 md:px-7 md:py-6",
          TONE_SURFACE[tone],
          className,
        )}
        {...props}
      >
        {/* `data-banner-body` is the reveal's fade handle. */}
        <div
          {...{ [BODY_ATTR]: "" }}
          className="flex flex-wrap items-center justify-between gap-x-8 gap-y-5"
        >
          <div className="flex min-w-0 flex-col gap-1.5 max-[30rem]:w-full">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <SectionLabel tone={tone === "alert" ? "alert" : "warn"}>
                {running || complete || resolved
                  ? "Diagnostic"
                  : unitStatusCopy(unit.status)}
              </SectionLabel>
              {acked ? <SectionLabel>Acknowledged</SectionLabel> : null}
            </div>
            {/* aria-live so the state swaps are spoken. */}
            <p
              id="incident-headline"
              aria-live="polite"
              className="text-heading text-ink"
            >
              {headline}
            </p>
            {detail ? <p className="text-small text-ink-soft">{detail}</p> : null}
            {openFor !== null && firstRaisedAt !== undefined ? (
              <p className="text-label tracking-normal text-ink-soft">
                Raised <span className="tnum">{clockTime(firstRaisedAt)}</span> · open for{" "}
                <span className="tnum">{openFor}</span>
              </p>
            ) : null}
          </div>

          {/* One black pill per screen, and it belongs to the alert state. */}
          {running || complete ? (
            viewable ? (
              <ViewDiagnosticButton size="md" className="max-[30rem]:w-full">
                {complete ? "View verdict" : "View scan"}
              </ViewDiagnosticButton>
            ) : null
          ) : resolved ? (
            <RunDiagnosticButton
              unitId={unitId}
              size="md"
              variant="secondary"
              className="max-[30rem]:w-full"
            >
              Run diagnostic again
            </RunDiagnosticButton>
          ) : complete ? null : (
            <RunDiagnosticButton
              unitId={unitId}
              size="lg"
              variant="primary"
              className="max-[30rem]:w-full"
            />
          )}
        </div>

        {/* A progress hairline; hidden under reduced motion (app/styles/operator.css). */}
        {running ? <span aria-hidden className="diag-sweep" /> : null}
      </section>
    </BannerReveal>
  );
}
