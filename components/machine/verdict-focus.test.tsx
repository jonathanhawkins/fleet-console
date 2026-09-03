import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type VerdictReport } from "@/lib/schema";
import { type DiagSession } from "@/lib/stores";
import { VerdictCard } from "./verdict-card";
import { VerdictSheet } from "./verdict-sheet";

/**
 * The payload of the whole demo is the verdict, not the RETURN button — this
 * file is the contract that a screen reader hears the finding the instant it
 * arrives, on both surfaces the card renders on (verdict-card.test.tsx covers
 * everything else the card says; this is the focus and naming seam alone, kept
 * apart from that file for the same reason it is not extended here).
 */

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY.",
  recommendations: ["Recalibrate joint", "Dispatch service"],
  ts: 120_000,
};

const ref = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5];

const session = (over: Partial<DiagSession> = {}): DiagSession => ({
  unitId: "N-07",
  startedAt: 1_700_000_000_000,
  walkLines: [],
  channels: [{ joint: "knee_L", ref, wave: ref.map((v) => v * 1.7) }],
  flag: { k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" },
  report,
  acknowledged: [],
  calibration: null,
  ...over,
});

/**
 * A simplified accessible-name-from-`aria-labelledby` resolution: join the
 * text content of every id it lists, in order. Sufficient here because every
 * element this file points it at is plain text with no name of its own to
 * override — the full algorithm's extra cases do not apply.
 */
function accessibleName(container: HTMLElement, el: Element): string {
  const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return ids
    .map((id) => container.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
    .join(" ")
    .trim();
}

describe("VerdictCard — focus and naming on arrival", () => {
  it("focuses the section itself, not RETURN, and names the joint, part and anomaly", () => {
    const { container } = render(<VerdictCard session={session()} />);
    const section = container.querySelector('[data-slot="verdict-card"]');
    expect(section).not.toBeNull();
    expect(section).toHaveFocus();
    expect(section).toHaveAttribute("tabindex", "-1");

    const returnButton = within(container).getByRole("button", {
      name: /return to console/i,
    });
    expect(document.activeElement).not.toBe(returnButton);

    const name = accessibleName(container, section!);
    expect(name).toMatch(/KNEE_L/);
    expect(name).toMatch(/ACTUATOR A-07/);
    expect(name).toMatch(/gain anomaly/i);
  });

  it("names the cleared outcome once a recalibration has answered it", () => {
    const { container } = render(
      <VerdictCard
        session={session({
          calibration: {
            k: "recalibration",
            joint: "knee_L",
            wave: ref.map((v) => v * 1.02),
            ref,
            outcome: "cleared",
          },
        })}
      />,
    );
    const section = container.querySelector('[data-slot="verdict-card"]')!;
    expect(section).toHaveFocus();
    const name = accessibleName(container, section);
    expect(name).toMatch(/gain anomaly/i);
    expect(name).toMatch(/cleared/i);
  });

  it("names the partial outcome the same way", () => {
    const { container } = render(
      <VerdictCard
        session={session({
          calibration: {
            k: "recalibration",
            joint: "knee_L",
            wave: ref.map((v) => v * 1.5),
            ref,
            outcome: "partial",
          },
        })}
      />,
    );
    const section = container.querySelector('[data-slot="verdict-card"]')!;
    const name = accessibleName(container, section);
    expect(name).toMatch(/partial/i);
  });

  it("names a clean scan by its one line, with no separate anomaly reference", () => {
    const clean = session({
      flag: null,
      report: {
        ...report,
        joint: "all",
        component: "all",
        anomaly: "none",
        summary: "SCAN COMPLETE. 6 CHANNELS WITHIN TOLERANCE. NO ANOMALY DETECTED.",
        recommendations: ["No action required"],
      },
    });
    const { container } = render(<VerdictCard session={clean} />);
    const section = container.querySelector('[data-slot="verdict-card"]')!;
    expect(section).toHaveFocus();
    expect(section.getAttribute("aria-labelledby")).toBe("verdict-headline");
    expect(accessibleName(container, section)).toMatch(/no anomaly detected/i);
  });

  it("keeps RETURN one Tab away when nothing else in the card can take focus first", async () => {
    const user = userEvent.setup();
    const bare = session({ report: { ...report, recommendations: [] } });
    // No onMinimize (nothing to put the card down with) and no recommendations
    // (no EXECUTE or RECORD group) — RETURN is the section's only focusable
    // descendant, so this is the direct, honest way to show it is never more
    // than one Tab from the finding that just took focus.
    render(<VerdictCard session={bare} />);

    await user.tab();
    expect(
      document.activeElement,
      "RETURN should be the first and only stop after the verdict section",
    ).toHaveAccessibleName(/return to console/i);
  });
});

describe("VerdictSheet — the phone surface renders the same card, focused the same way", () => {
  it("focuses the section inside the sheet and names the finding", () => {
    const { container } = render(
      <VerdictSheet open onMinimize={() => {}} onRestore={() => {}} reduced>
        <VerdictCard session={session()} surface="sheet" />
      </VerdictSheet>,
    );
    const section = container.querySelector('[data-slot="verdict-card"]');
    expect(section).not.toBeNull();
    expect(section).toHaveFocus();

    const name = accessibleName(container, section!);
    expect(name).toMatch(/KNEE_L/);
    expect(name).toMatch(/gain anomaly/i);
  });
});
