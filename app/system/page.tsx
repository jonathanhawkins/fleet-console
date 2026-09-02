import { Fragment } from "react";
import type { Metadata } from "next";
import {
  ConsoleButton,
  ConsoleCard,
  SectionLabel,
  StatusChip,
} from "@/components/console";
import { FLEET_UNITS } from "@/sim/engine";
import { TokenSwatch, TypeSpecimen } from "./token-readout";

export const metadata: Metadata = {
  title: "Design system",
  description:
    "The Fleet Console component library rendered in both spaces: operator and machine.",
};

/* -------------------------------------------------------------------------- */
/* Shared layout                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A specimen household, named by the fleet the app actually ships.
 *
 * `/system` is a shipped route (PRD §6), so the names on it are read by
 * reviewers alongside the console itself — and retyped ones drift: a rename in
 * `sim/engine.ts` reached three e2e specs and left this gallery showing
 * households no fleet contains. The roster is the single source, so the next
 * rename lands here for free. This is a server component in a static export,
 * so the lookup runs at build time and an id that leaves the roster fails the
 * build instead of shipping a blank card.
 */
function household(id: string): string {
  const unit = FLEET_UNITS.find((u) => u.id === id);
  if (!unit)
    throw new Error(`/system names unit ${id}, which the fleet roster does not have`);
  return unit.name;
}

/**
 * The careers-page reference column: a small wide-tracked label parked in a narrow left
 * rail, the content given the whole rest of the width. It is the single strongest
 * gesture in the operator reference, and it collapses gracefully at tablet width.
 */
function Group({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-6 border-t border-line py-16 md:grid-cols-[200px_1fr] md:gap-16 machine:py-10">
      {/* deliberately not sticky: the rail label must sit level with the first
          line of its content, which is the whole gesture being borrowed */}
      <div className="flex flex-col gap-2 self-start">
        <SectionLabel as="h2" tone="ink">
          {label}
        </SectionLabel>
        {note ? (
          <p className="max-w-[15rem] text-small text-ink-soft machine:text-ink-muted">
            {note}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/**
 * Both worlds open the same way — label, headline, one paragraph, three facts —
 * so that the differences a reader notices are only the ones the tokens make.
 */
function SpaceHeader({
  label,
  headline,
  blurb,
  meta,
}: {
  label: string;
  headline: string;
  blurb: string;
  meta: readonly string[];
}) {
  return (
    <header className="grid gap-6 pb-14 md:grid-cols-[200px_1fr] md:gap-16 machine:pb-10">
      <SectionLabel className="self-start">{label}</SectionLabel>
      <div className="flex flex-col gap-5">
        <h1 className="max-w-[24ch] text-display text-balance text-ink case-heading">
          {headline}
        </h1>
        <p className="max-w-[34rem] text-body text-ink-soft">{blurb}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 text-label text-ink-soft machine:text-ink-muted">
          {meta.map((m, i) => (
            <Fragment key={m}>
              {i > 0 ? <span className="h-3 w-px bg-line-strong" aria-hidden /> : null}
              <span>{m}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </header>
  );
}

function SwatchGrid({
  tokens,
}: {
  tokens: ReadonlyArray<{ token: string; role: string; note?: string }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5 machine:gap-x-4 machine:gap-y-5">
      {tokens.map((t) => (
        <TokenSwatch key={t.token} token={t.token} role={t.role} note={t.note} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Operator space                                                             */
/* -------------------------------------------------------------------------- */

const OPERATOR_TOKENS = [
  { token: "bg", role: "Page, warm white" },
  { token: "surface", role: "Panels, greige" },
  { token: "surface-2", role: "Nested panels" },
  { token: "ink", role: "Primary text" },
  { token: "ink-soft", role: "Secondary text" },
  {
    token: "muted",
    role: "Decoration, large text",
    note: "3.31:1 — large text and decoration only; body-size text uses --ink-soft.",
  },
  { token: "line", role: "Hairlines" },
  { token: "line-strong", role: "Emphasised rules" },
  { token: "nominal", role: "Sage, all clear" },
  { token: "warn", role: "Amber, attention" },
  { token: "alert", role: "Clay, alert" },
  { token: "nominal-tint", role: "Chip ground" },
  { token: "warn-tint", role: "Chip ground" },
  { token: "alert-tint", role: "Chip ground" },
] as const;

function OperatorSpace() {
  return (
    <section
      data-space="operator"
      className="bg-bg px-8 pt-20 pb-8 text-ink md:px-16 lg:px-24"
    >
      <div className="mx-auto max-w-[1400px]">
        <SpaceHeader
          label="Operator space"
          headline="Calm enough to glance at, like a thermostat."
          blurb="The default world. Warm white, generous whitespace, muted status colour, pill buttons. An operator watching eight healthy homes should feel nothing at all. No neon reaches this space."
          meta={["Geist Sans", "Radius 12px", "Soft elevation"]}
        />

        <Group
          label="Colour"
          note="Every value below is read back from the live stylesheet."
        >
          <SwatchGrid tokens={OPERATOR_TOKENS} />
        </Group>

        <Group label="Type" note="Geist Sans. Sentence case, tight display tracking.">
          <div className="border-t border-line">
            <TypeSpecimen step="display">All units nominal.</TypeSpecimen>
            <TypeSpecimen step="title">{household("N-07")}</TypeSpecimen>
            <TypeSpecimen step="heading">Left knee actuator</TypeSpecimen>
            <TypeSpecimen step="body">
              Eight units reporting. Average battery 78 percent, no open incidents.
            </TypeSpecimen>
            <TypeSpecimen step="small">Last contact 4 seconds ago</TypeSpecimen>
            <TypeSpecimen step="label">Fleet status</TypeSpecimen>
          </div>
        </Group>

        <Group label="Status" note="Tinted, never loud. The fleet is usually fine.">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip status="nominal">Nominal</StatusChip>
              <StatusChip status="warn">Attention</StatusChip>
              <StatusChip status="alert">Alert</StatusChip>
            </div>
            {/* The list variant. Eight rows of tinted NOMINAL out-shout the one
                row that is not, so a dense list drops the ground and keeps the
                word — see the fleet rail. */}
            <div className="flex flex-wrap items-center gap-6">
              <StatusChip status="nominal" tone="bare">
                Nominal
              </StatusChip>
              <StatusChip status="warn" tone="bare">
                Attention
              </StatusChip>
              <StatusChip status="alert" tone="bare">
                Alert
              </StatusChip>
            </div>
          </div>
        </Group>

        <Group label="Action" note="One black pill per screen. Everything else recedes.">
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-center gap-3">
              <ConsoleButton variant="primary">Run diagnostic</ConsoleButton>
              <ConsoleButton variant="secondary">View telemetry</ConsoleButton>
              <ConsoleButton variant="ghost">Dismiss</ConsoleButton>
              <ConsoleButton variant="danger">Disable joint</ConsoleButton>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ConsoleButton size="sm" variant="secondary">
                Small
              </ConsoleButton>
              <ConsoleButton size="md" variant="secondary">
                Medium
              </ConsoleButton>
              <ConsoleButton size="lg" variant="primary">
                Order
              </ConsoleButton>
            </div>
          </div>
        </Group>

        <Group label="Surface" note="Separated by warmth and a hairline, not by weight.">
          <div className="grid gap-5 lg:grid-cols-3">
            <ConsoleCard
              variant="plain"
              label={household("N-07")}
              action={<StatusChip status="nominal">Nominal</StatusChip>}
            >
              <p className="tnum text-title text-ink">N-07</p>
              <p className="mt-1 text-small text-ink-soft machine:text-ink-muted">
                Battery 82 percent · 4 s ago
              </p>
            </ConsoleCard>
            <ConsoleCard
              variant="outlined"
              label={household("N-03")}
              action={<StatusChip status="warn">Attention</StatusChip>}
            >
              <p className="tnum text-title text-ink">N-03</p>
              <p className="mt-1 text-small text-ink-soft machine:text-ink-muted">
                Torque ripple on left knee
              </p>
            </ConsoleCard>
            <ConsoleCard
              variant="raised"
              label={household("N-05")}
              action={<StatusChip status="alert">Alert</StatusChip>}
            >
              <p className="tnum text-title text-ink">N-05</p>
              <p className="mt-1 text-small text-ink-soft machine:text-ink-muted">
                Actuator over temperature
              </p>
            </ConsoleCard>
          </div>
        </Group>

        <Group label="Label" note="The quiet workhorse. Names a region, never competes.">
          <div className="flex max-w-[52ch] flex-col gap-6">
            <SectionLabel rule>Fleet status</SectionLabel>
            <SectionLabel tone="ink" rule>
              Subsystems
            </SectionLabel>
            <SectionLabel tone="alert" rule>
              Open incident
            </SectionLabel>
          </div>
        </Group>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Machine space                                                              */
/* -------------------------------------------------------------------------- */

const MACHINE_TOKENS = [
  { token: "bg", role: "Void" },
  { token: "ink", role: "Phosphor" },
  { token: "ink-soft", role: "Body" },
  { token: "muted", role: "Meta" },
  { token: "line", role: "Grid" },
  { token: "line-strong", role: "Rule" },
  { token: "nominal", role: "Operating" },
  { token: "warn", role: "Degraded" },
  { token: "alert", role: "Damaged" },
  { token: "signal", role: "Magenta, rare" },
] as const;

/**
 * The eva-parts-status board, built entirely out of StatusChip + the token layer.
 * Nothing here is a new component — that is the point of showing it.
 */
const PARTS: ReadonlyArray<{
  id: string;
  part: string;
  status: "nominal" | "warn" | "alert";
  label: string;
}> = [
  { id: "0001", part: "HIP_L", status: "nominal", label: "Operating" },
  { id: "0002", part: "HIP_R", status: "nominal", label: "Operating" },
  { id: "0003", part: "KNEE_L", status: "alert", label: "Damaged" },
  { id: "0004", part: "KNEE_R", status: "nominal", label: "Operating" },
  { id: "0005", part: "ANKLE_L", status: "nominal", label: "Operating" },
  { id: "0006", part: "ANKLE_R", status: "nominal", label: "Operating" },
  { id: "0007", part: "SHOULDER_L", status: "nominal", label: "Operating" },
  { id: "0008", part: "SHOULDER_R", status: "warn", label: "Degraded" },
  { id: "0009", part: "ELBOW_L", status: "nominal", label: "Operating" },
  { id: "0010", part: "ELBOW_R", status: "nominal", label: "Operating" },
  { id: "0011", part: "WRIST_L", status: "nominal", label: "Operating" },
  { id: "0012", part: "TORSO_YAW", status: "nominal", label: "Operating" },
];

function PartsBoard() {
  return (
    <div className="grid gap-x-10 gap-y-0 lg:grid-cols-2">
      {PARTS.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-3 border-b border-line py-1.5 last:border-b-0"
        >
          {/* bare text-ink-muted, deliberately: this board only ever renders in
              machine space, where --muted is the dim phosphor tier the reference
              boards depend on. The operator --muted ruling does not reach here. */}
          <span className="tnum text-small text-ink-muted">{p.id}</span>
          <span className="text-ink-muted">—</span>
          <span className="text-small text-ink-soft">{p.part}</span>
          <span className="mx-1 h-px flex-1 bg-line" aria-hidden />
          <StatusChip status={p.status}>{p.label}</StatusChip>
        </div>
      ))}
    </div>
  );
}

function MachineSpace() {
  return (
    <section
      data-space="machine"
      className="bg-bg px-8 pt-16 pb-10 text-ink md:px-16 lg:px-24"
    >
      <div className="mx-auto max-w-[1400px]">
        <SpaceHeader
          label="Machine space"
          headline="What the robot says about itself"
          blurb="Entered, never toggled. Phosphor mono on the void, radius zero, no elevation anywhere — hierarchy comes from luminance and one-pixel rules. Every component below is the same component as above."
          meta={["JetBrains Mono", "Radius 0", "Scanline 3.5%"]}
        />

        <Group label="Colour" note="Read back live, same as above.">
          <SwatchGrid tokens={MACHINE_TOKENS} />
        </Group>

        <Group label="Type" note="Uppercase system voice. Dense leading.">
          <div className="border-t border-line">
            <TypeSpecimen step="display">Diagnostic</TypeSpecimen>
            <TypeSpecimen step="title">Unit N-07</TypeSpecimen>
            <TypeSpecimen step="heading">Actuator bus</TypeSpecimen>
            <TypeSpecimen step="body">Scanning channel 06 of 06</TypeSpecimen>
            <TypeSpecimen step="small">Ref delta +0.42 gain</TypeSpecimen>
            <TypeSpecimen step="label">Subsystem</TypeSpecimen>
          </div>
        </Group>

        <Group
          label="Status"
          note="Inverted blocks. The same StatusChip, no props changed."
        >
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status="nominal">Operating</StatusChip>
            <StatusChip status="warn">Degraded</StatusChip>
            <StatusChip status="alert">Damaged</StatusChip>
          </div>
        </Group>

        <Group label="Parts" note="Operating parts manifest.">
          <PartsBoard />
        </Group>

        <Group
          label="Action"
          note="Square, mono, uppercase. The pill token is zero here."
        >
          <div className="flex flex-wrap items-center gap-3">
            <ConsoleButton variant="primary">Execute</ConsoleButton>
            <ConsoleButton variant="secondary">Channel map</ConsoleButton>
            <ConsoleButton variant="ghost">Abort</ConsoleButton>
            <ConsoleButton variant="danger">Disable joint</ConsoleButton>
          </div>
        </Group>

        <Group label="Surface" note="No elevation. A one-pixel box on the void.">
          <div className="grid gap-4 lg:grid-cols-3">
            <ConsoleCard
              label="Channel 03"
              action={<StatusChip status="alert">Damaged</StatusChip>}
            >
              <p className="tnum text-title text-alert">KNEE_L</p>
              <p className="mt-1 text-small text-ink-soft machine:text-ink-muted">
                Gain anomaly · A-07
              </p>
            </ConsoleCard>
            <ConsoleCard
              label="Channel 08"
              action={<StatusChip status="warn">Degraded</StatusChip>}
            >
              <p className="tnum text-title text-warn">SHOULDER_R</p>
              <p className="mt-1 text-small text-ink-soft machine:text-ink-muted">
                Ripple within tolerance
              </p>
            </ConsoleCard>
            <ConsoleCard
              label="Channel 01"
              action={<StatusChip status="nominal">Operating</StatusChip>}
            >
              <p className="tnum text-title text-ink">HIP_L</p>
              <p className="mt-1 text-small text-ink-soft machine:text-ink-muted">
                Matches reference trace
              </p>
            </ConsoleCard>
          </div>
        </Group>

        <Group label="Label" note="Rules run to the edge, as on the reference boards.">
          <div className="flex max-w-[52ch] flex-col gap-5">
            <SectionLabel rule>Subsystem scan</SectionLabel>
            <SectionLabel tone="ink" rule>
              Actuator bus
            </SectionLabel>
            <SectionLabel tone="alert" rule>
              Divergence flagged
            </SectionLabel>
          </div>
        </Group>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

export default function SystemPage() {
  // The disclaimer footer is rendered by the root layout, on every route.
  return (
    <main>
      <OperatorSpace />
      <MachineSpace />
    </main>
  );
}
