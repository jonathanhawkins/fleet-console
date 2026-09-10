import {
  BatteryMeter,
  ConnectionStatus,
  ConsoleButton,
  ConsoleCard,
  ConsoleFooter,
  ConsoleHeader,
  Disclosure,
  PostureTag,
  RegionNote,
  SectionLabel,
  StatGroup,
  StatusChip,
  UnitCard,
} from "@/components/console";
import { type Specimen } from "./library";

/**
 * The library, one entry per exported component.
 *
 * `catalogue.test.ts` asserts this list names every component the barrel
 * exports, so a component added to `@/components/console` fails the suite until
 * it is documented here. That test is the only thing that keeps a page like
 * this honest as a library grows.
 *
 * Prop rows are transcribed from each component's own props interface. They are
 * checked by eye, not generated: a generator would have to parse TypeScript at
 * build time to say anything a reader could not get from the source, and the
 * value here is the one-line meaning, which no generator knows.
 */

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-3">{children}</div>
);

export const SPECIMENS: readonly Specimen[] = [
  {
    name: "ConsoleButton",
    purpose:
      "Every press in the product. One primary per page, and it is the incident’s.",
    usage: `<ConsoleButton variant="primary" size="md">Run diagnostic</ConsoleButton>`,
    props: [
      {
        name: "variant",
        type: `"primary" | "secondary" | "ghost" | "danger"`,
        fallback: `"primary"`,
        note: "Primary is the one black pill; danger is reserved for a command that reaches the robot.",
      },
      {
        name: "size",
        type: `"sm" | "md" | "lg"`,
        fallback: `"md"`,
        note: "Row, body, hero.",
      },
      {
        name: "asChild",
        type: "boolean",
        fallback: "false",
        note: "Render the child element instead of a button — a link that should look like one.",
      },
    ],
    a11y: "Focus is the global :focus-visible ring, unlayered so it survives in both spaces. A button that acts on the robot never relies on colour alone: the confirmation states the consequence in words.",
    render: () => (
      <div className="flex flex-col gap-3">
        <Row>
          <ConsoleButton size="sm">Primary</ConsoleButton>
          <ConsoleButton variant="secondary" size="sm">
            Secondary
          </ConsoleButton>
          <ConsoleButton variant="ghost" size="sm">
            Ghost
          </ConsoleButton>
          <ConsoleButton variant="danger" size="sm">
            Danger
          </ConsoleButton>
        </Row>
        <Row>
          <ConsoleButton disabled size="sm">
            Disabled
          </ConsoleButton>
          <ConsoleButton size="lg">Run diagnostic</ConsoleButton>
        </Row>
      </div>
    ),
  },
  {
    name: "ConsoleCard",
    purpose: "A region of the page, with an optional label row and a trailing slot.",
    usage: `<ConsoleCard label="Fleet map" labelAs="h2" action={<StatusChip>Live</StatusChip>}>…</ConsoleCard>`,
    props: [
      {
        name: "label",
        type: "ReactNode",
        fallback: "—",
        note: "Rendered above the content with a hairline to the card’s edge.",
      },
      {
        name: "labelAs",
        type: `"div" | "p" | "span" | "h2" | "h3" | "figcaption"`,
        fallback: `"div"`,
        note: "Promote the label to a real heading when the card names a region of the page.",
      },
      {
        name: "action",
        type: "ReactNode",
        fallback: "—",
        note: "Trailing slot on the label row.",
      },
      {
        name: "variant",
        type: `"plain" | "outlined" | "raised"`,
        fallback: `"plain"`,
        note: "Plain is the greige ground; raised is for a card that floats over content.",
      },
      {
        name: "padding",
        type: `"none" | "default"`,
        fallback: `"default"`,
        note: "None when the card holds a canvas or a list that owns its own inset.",
      },
    ],
    a11y: "A card that is a region of the page owes the document a heading — pass labelAs. A card that is one row of a list does not, and passing it would put junk in the outline.",
    render: () => (
      <ConsoleCard label="Units" action={<StatusChip>8 live</StatusChip>}>
        <p className="text-small text-ink-soft">Card content.</p>
      </ConsoleCard>
    ),
  },
  {
    name: "SectionLabel",
    purpose: "The small-caps wide-tracked label that names everything.",
    usage: `<SectionLabel as="h2" tone="ink" rule>Joint telemetry</SectionLabel>`,
    props: [
      {
        name: "tone",
        type: `"muted" | "ink" | "nominal" | "warn" | "alert"`,
        fallback: `"muted"`,
        note: "Muted is the default voice; the status tones are for a label that carries state.",
      },
      {
        name: "rule",
        type: "boolean",
        fallback: "false",
        note: "Run a hairline from the end of the label to the edge of its container.",
      },
      {
        name: "as",
        type: `"div" | "p" | "span" | "h2" | "h3" | "figcaption"`,
        fallback: `"div"`,
        note: "A heading when the label names a section, a div when it is decoration.",
      },
    ],
    render: () => (
      <div className="flex flex-col gap-3">
        <SectionLabel>Muted</SectionLabel>
        <SectionLabel tone="ink">Ink</SectionLabel>
        <SectionLabel tone="alert">Alert</SectionLabel>
        <SectionLabel rule>With a rule</SectionLabel>
      </div>
    ),
  },
  {
    name: "StatusChip",
    purpose:
      "One chip, two grammars: a quiet tinted pill, or an inverted machine-space block.",
    usage: `<StatusChip status="alert">Alert</StatusChip>`,
    props: [
      {
        name: "status",
        type: `"nominal" | "warn" | "alert"`,
        fallback: `"nominal"`,
        note: "The state being reported; picks the tint and the ink together.",
      },
      {
        name: "tone",
        type: `"auto" | "quiet" | "inverted" | "bare"`,
        fallback: `"auto"`,
        note: "Auto lets the space decide. Quiet drops the ground; inverted is the DAMAGED stamp; bare is text only.",
      },
    ],
    a11y: "The word is the status, and the colour agrees with it — never the reverse. A nominal chip is deliberately unfilled, so the tinted grounds are only ever spent on trouble.",
    render: () => (
      <div className="flex flex-col gap-3">
        <Row>
          <StatusChip>Nominal</StatusChip>
          <StatusChip status="warn">Attention</StatusChip>
          <StatusChip status="alert">Alert</StatusChip>
        </Row>
        <Row>
          <StatusChip tone="quiet">Quiet</StatusChip>
          <StatusChip status="warn" tone="bare">
            Bare
          </StatusChip>
        </Row>
      </div>
    ),
    renderMachineOnly: () => (
      <Row>
        <StatusChip status="alert" tone="inverted">
          Damaged
        </StatusChip>
        <StatusChip status="nominal" tone="inverted">
          Operating
        </StatusChip>
      </Row>
    ),
  },
  {
    name: "StatGroup",
    purpose: "A labelled figure in the KPI band, with an honest empty state.",
    usage: `<dl>\n  <StatGroup label="Units nominal" value="8" unit="of 8" />\n</dl>`,
    props: [
      {
        name: "label",
        type: "ReactNode",
        note: "Sentence case in source; the label step uppercases it.",
      },
      {
        name: "value",
        type: "ReactNode",
        fallback: "—",
        note: "The figure. Ignored while pending.",
      },
      {
        name: "unit",
        type: "ReactNode",
        fallback: "—",
        note: "Trailing unit, smaller and softer than the figure.",
      },
      {
        name: "pending",
        type: "boolean",
        fallback: "false",
        note: "No data yet: renders an em-dash rather than inventing a zero.",
      },
      {
        name: "acknowledge",
        type: "boolean",
        fallback: "false",
        note: "One-shot beat when the value moves: a rule in the figure’s own ink, over a wash the status tones alone light. Not on the first reading, which has its own.",
      },
      {
        name: "size",
        type: `"md" | "sm"`,
        fallback: `"md"`,
        note: "Band, or inline in a header.",
      },
      {
        name: "tone",
        type: `"ink" | "soft" | "nominal" | "warn" | "alert"`,
        fallback: `"ink"`,
        note: "The figure’s colour when the number itself is the alarm.",
      },
    ],
    a11y: "It renders a `dt`/`dd` pair, so it must sit inside a `dl` — the KPI band on the fleet page is that list. Pending renders an em-dash rather than a zero, because a fleet that has not reported is not a fleet of zero. The `acknowledge` beat is decoration on two pseudo-elements: it carries nothing a screen reader needs, changes no contrast, and reduced motion resolves it to nothing rather than to a frozen mark.",
    render: () => (
      // The `dl` is the point: see the note below.
      <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <StatGroup label="Units nominal" value="8" unit="of 8" />
        <StatGroup label="Alerting" value="1" tone="alert" />
        <StatGroup label="Avg battery" pending />
      </dl>
    ),
  },
  {
    name: "BatteryMeter",
    purpose: "The number, plus a thin unlabelled bar. Ink until it is low.",
    usage: `<BatteryMeter value={73} />`,
    props: [
      {
        name: "value",
        type: "number | null",
        note: "Percent 0–100, or null for no reading yet.",
      },
      {
        name: "trackClassName",
        type: "string",
        fallback: "—",
        note: "Width of the track. Defaults to a fixed measure so it reads as a gauge.",
      },
    ],
    a11y: "The percentage is text, so the bar is decoration and carries no separate label. A null value says so in words rather than drawing an empty gauge.",
    render: () => (
      <div className="flex flex-col gap-3">
        <BatteryMeter value={73} />
        <BatteryMeter value={12} />
        <BatteryMeter value={null} />
      </div>
    ),
  },
  {
    name: "Disclosure",
    purpose: "Height-animated reveal for a row’s own detail. Open is the caller’s state.",
    usage: `<Disclosure open={expanded}>{detail}</Disclosure>`,
    props: [
      {
        name: "open",
        type: "boolean",
        note: "The caller owns the state; this animates to match.",
      },
      {
        name: "children",
        type: "ReactNode",
        note: "Mounted on first open and kept, so the exit can play.",
      },
    ],
    a11y: "The trigger belongs to the caller, which is what lets the row’s own control own aria-expanded and aria-controls.",
    render: () => (
      <div className="flex flex-col gap-2">
        <SectionLabel>Open</SectionLabel>
        <Disclosure open>
          <p className="text-small text-ink-soft">Revealed detail.</p>
        </Disclosure>
        <SectionLabel>Closed</SectionLabel>
        <Disclosure open={false}>
          <p className="text-small text-ink-soft">Hidden detail.</p>
        </Disclosure>
      </div>
    ),
  },
  {
    name: "RegionNote",
    purpose: "What a region says when it has nothing to show, without claiming a fault.",
    usage: `<RegionNote>Units appear here as the fleet reports in.</RegionNote>`,
    props: [],
    a11y: "It describes the region rather than asserting emptiness, so a screen reader hears what will arrive instead of an error.",
    render: () => <RegionNote>Alerts appear here as they are raised.</RegionNote>,
  },
  {
    name: "PostureTag",
    purpose: "Gross body posture, printed only when it is not the default.",
    usage: `<PostureTag posture="sitting" />`,
    props: [
      {
        name: "posture",
        type: "Posture | undefined",
        fallback: "undefined",
        note: "Undefined reads as walking and renders nothing; only sitting prints.",
      },
    ],
    a11y: "Rendering nothing for the ordinary case is the point: a tag on every row would be noise, and its absence is not information a reader has to decode.",
    render: () => (
      <Row>
        <PostureTag posture="sitting" />
        <span className="text-small text-ink-soft">walking renders nothing</span>
      </Row>
    ),
  },
  {
    name: "UnitCard",
    purpose:
      "One home in the fleet, as a row that links to its unit. One fixed height, and one exception.",
    usage: `<UnitCard unitId="N-07" name="Elm House" status="red" battery={93} recency="just now" />`,
    props: [
      { name: "unitId", type: "string", note: "Also the link target: /unit/<id>." },
      { name: "name", type: "string", note: "The household, as the roster names it." },
      {
        name: "status",
        type: "UnitStatus",
        note: "nominal, amber or red; picks the chip.",
      },
      {
        name: "battery",
        type: "number",
        note: "Percent, rendered whole — a rail is not a gauge.",
      },
      {
        name: "recency",
        type: "string | null",
        fallback: "—",
        note: "Last contact, omitted when there is nothing truthful to say.",
      },
      {
        name: "posture",
        type: "Posture",
        fallback: "—",
        note: "Passed through to PostureTag.",
      },
      {
        name: "fw",
        type: "string | null",
        fallback: "—",
        note: "The build, passed only while the unit is in a live firmware cohort.",
      },
      {
        name: "cohort",
        type: "boolean",
        fallback: "false",
        note: "Marks the row as a cohort member.",
      },
      {
        name: "trend",
        type: "UnitTrend",
        fallback: "—",
        note: "A climbing joint on a unit that still reads nominal.",
      },
    ],
    a11y: "The row is one link with one accessible name carrying every fact it shows, so a screen reader hears the unit, its state, its battery and its last contact in one breath instead of four.",
    render: () => (
      <div className="flex flex-col">
        <UnitCard
          unitId="N-07"
          name="Elm House"
          status="red"
          battery={93}
          recency="just now"
        />
        <UnitCard
          unitId="N-01"
          name="Prospect Row"
          status="nominal"
          battery={73}
          recency="just now"
        />
        {/* The one row that is not 72px tall: a unit still reading nominal
            with a joint climbing under it. The third line is what the row has
            to say about the other two, so the row grows to hold it and keeps
            the padding of the two above. */}
        <UnitCard
          unitId="N-04"
          name="Taylor Bend"
          status="nominal"
          battery={88}
          recency="just now"
          trend={{ joint: "knee_L", cPerMin: 18 }}
        />
      </div>
    ),
  },
  {
    name: "ConnectionStatus",
    purpose:
      "The transport reporting its own state. Colour lives in the dot, never the word.",
    usage: `<ConnectionStatus state="live" />`,
    props: [
      {
        name: "state",
        type: "ConnectionState",
        fallback: `"idle"`,
        note: "idle (nothing has tried yet), connecting, live, or lost.",
      },
    ],
    a11y: "Only lost is allowed to interrupt a glance, so it is the one state that colours the word as well as the dot.",
    render: () => (
      <div className="flex flex-col gap-3">
        <ConnectionStatus state="idle" />
        <ConnectionStatus state="connecting" />
        <ConnectionStatus state="live" />
        <ConnectionStatus state="lost" />
      </div>
    ),
  },
  {
    name: "ConsoleHeader",
    purpose: "The product mark, the simulated-data tag, and a trailing slot.",
    usage: `<ConsoleHeader><ConnectionStatus state="live" /></ConsoleHeader>`,
    props: [
      {
        name: "children",
        type: "ReactNode",
        fallback: "—",
        note: "Trailing slot: the app puts its live connection state there.",
      },
    ],
    wide: true,
    render: () => (
      <ConsoleHeader>
        <ConnectionStatus state="live" />
      </ConsoleHeader>
    ),
  },
  {
    name: "ConsoleFooter",
    purpose: "The disclaimer that appears on every page, and a slot beside it.",
    usage: `<ConsoleFooter><SimReset /></ConsoleFooter>`,
    props: [
      {
        name: "children",
        type: "ReactNode",
        fallback: "—",
        note: "Trailing slot beside the disclaimer, at the same volume as it.",
      },
    ],
    wide: true,
    a11y: "The footer knows nothing about the simulator; the demo’s own controls are passed in, which is what lets it render in any composition.",
    render: () => <ConsoleFooter />,
  },
];
