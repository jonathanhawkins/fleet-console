import { SectionLabel } from "@/components/console";

/**
 * How a component is documented on this page.
 *
 * The gallery used to be a specimen sheet: it showed four of the library's
 * thirteen components and said nothing about how to use any of them, while the
 * README carried the prop tables. A library whose documentation lives somewhere
 * else is not a documented library, so the two jobs swapped: the README points
 * here, and every entry below carries what a caller actually needs — the props,
 * the states worth seeing, one line of real usage, and the accessibility fact
 * that is easy to lose in a re-implementation.
 *
 * Every entry renders twice, once per space, from the same element. That is the
 * library's central claim (no component takes a `space` prop) and the only way
 * to see it is side by side.
 */

export interface PropRow {
  name: string;
  type: string;
  /** Omitted where the prop is required. */
  fallback?: string;
  note: string;
}

export interface Specimen {
  /** The exported name, exactly as `@/components/console` spells it. */
  name: string;
  /** What it is for, in one line. */
  purpose: string;
  props: readonly PropRow[];
  /** One real call, copy-pasteable. */
  usage: string;
  /** The fact a re-implementation loses first. */
  a11y?: string;
  /** The states worth seeing, laid out by the specimen itself. */
  render: () => React.ReactNode;
  /** Set for page chrome, which needs the full width rather than a column. */
  wide?: boolean;
  /**
   * States that exist in one space only — machine space's inverted stamp being
   * the one real case. Rendered under the pair, in the machine frame alone,
   * because showing it on the operator side would document a combination the
   * product never ships (and would fail contrast, since the operator sage was
   * never chosen to carry white type).
   */
  renderMachineOnly?: () => React.ReactNode;
}

function PropTable({ rows }: { rows: readonly PropRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-small text-ink-soft">
        Takes only the underlying element&rsquo;s own props.
      </p>
    );
  }
  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="border-b border-line">
          {["Prop", "Type", "Default", "Meaning"].map((h) => (
            <th
              key={h}
              scope="col"
              className="py-2 pr-4 text-label text-ink-soft uppercase"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-b border-line align-baseline last:border-0">
            <th
              scope="row"
              className="py-2.5 pr-4 font-mono text-small font-normal text-ink"
            >
              {r.name}
            </th>
            <td className="py-2.5 pr-4 font-mono text-small text-ink-soft">{r.type}</td>
            <td className="py-2.5 pr-4 font-mono text-small text-ink-soft">
              {r.fallback ?? <span className="text-ink-soft">required</span>}
            </td>
            <td className="py-2.5 text-small text-ink-soft">{r.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The same element, in both spaces, so the claim is checkable by eye.
 *
 * Page chrome stacks instead of sitting side by side: a header squeezed into
 * half a column is not the header anyone ships.
 */
function BothSpaces({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      className={
        wide
          ? "grid gap-px overflow-hidden border border-line"
          : "grid gap-px overflow-hidden border border-line sm:grid-cols-2"
      }
    >
      <div
        data-space="operator"
        className="flex min-h-[7rem] flex-col justify-center gap-4 bg-bg p-6 text-ink"
      >
        <SectionLabel>Operator</SectionLabel>
        {children}
      </div>
      <div
        data-space="machine"
        className="flex min-h-[7rem] flex-col justify-center gap-4 bg-bg p-6 text-ink"
      >
        <SectionLabel>Machine</SectionLabel>
        {children}
      </div>
    </div>
  );
}

function Usage({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto border border-line bg-surface px-4 py-3 font-mono text-small text-ink-soft">
      <code>{code}</code>
    </pre>
  );
}

export function SpecimenEntry({ spec }: { spec: Specimen }) {
  return (
    <section
      data-slot="specimen"
      data-component={spec.name}
      className="grid gap-6 border-t border-line py-14 md:grid-cols-[200px_1fr] md:gap-16"
    >
      <div className="flex flex-col gap-2 self-start">
        <SectionLabel as="h3" tone="ink" className="font-mono">
          {spec.name}
        </SectionLabel>
        <p className="max-w-[15rem] text-small text-ink-soft">{spec.purpose}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <BothSpaces wide={spec.wide}>{spec.render()}</BothSpaces>
        {spec.renderMachineOnly ? (
          <div
            data-space="machine"
            className="flex flex-col gap-4 border border-line bg-bg p-6 text-ink"
          >
            <SectionLabel>Machine only</SectionLabel>
            {spec.renderMachineOnly()}
          </div>
        ) : null}
        <Usage code={spec.usage} />
        <PropTable rows={spec.props} />
        {spec.a11y ? (
          <p className="max-w-[52ch] border-l-2 border-line-strong pl-4 text-small text-ink-soft">
            <span className="text-label text-ink uppercase">Accessibility</span>{" "}
            {spec.a11y}
          </p>
        ) : null}
      </div>
    </section>
  );
}
