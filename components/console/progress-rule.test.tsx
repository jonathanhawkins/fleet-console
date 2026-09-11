// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressRule } from "./progress-rule";

/**
 * A rule that reports rather than predicts.
 *
 * The assertions that matter are the ones about refusing to lie: a value
 * outside 0…1 is clamped rather than painted past the end of the track, and a
 * caller that says the source has stopped gets a bar that visibly is not
 * moving instead of one that merely looks slow.
 */

const label = (text = "Scan") => (
  <span id="rule-label" className="sr-only">
    {text}
  </span>
);

describe("ProgressRule", () => {
  it("paints the fraction it was given", () => {
    render(
      <>
        {label()}
        <ProgressRule value={0.25} labelledBy="rule-label" data-testid="rule" />
      </>,
    );
    const fill = screen.getByTestId("rule").firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("25%");
  });

  it("clamps rather than overflowing its own track", () => {
    render(
      <>
        {label()}
        <ProgressRule value={4} labelledBy="rule-label" data-testid="over" />
        <ProgressRule value={-2} labelledBy="rule-label" data-testid="under" />
      </>,
    );
    expect(
      (screen.getByTestId("over").firstElementChild as HTMLElement).style.width,
    ).toBe("100%");
    expect(
      (screen.getByTestId("under").firstElementChild as HTMLElement).style.width,
    ).toBe("0%");
  });

  it("reads a value that is not a number as empty, not as blank", () => {
    render(
      <>
        {label()}
        <ProgressRule value={Number.NaN} labelledBy="rule-label" data-testid="nan" />
      </>,
    );
    expect((screen.getByTestId("nan").firstElementChild as HTMLElement).style.width).toBe(
      "0%",
    );
  });

  it("counts in real units when given a pair", () => {
    render(
      <>
        {label()}
        <ProgressRule value={14 / 26} now={14} max={26} labelledBy="rule-label" />
      </>,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "14");
    expect(bar).toHaveAttribute("aria-valuemax", "26");
  });

  it("falls back to percent when the units are not countable", () => {
    render(
      <>
        {label()}
        <ProgressRule value={0.5} labelledBy="rule-label" />
      </>,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("is named by the element it points at", () => {
    render(
      <>
        {label("Walking subsystems")}
        <ProgressRule value={0.1} labelledBy="rule-label" />
      </>,
    );
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("Walking subsystems");
  });

  it("stops animating when the source stopped reporting", () => {
    render(
      <>
        {label()}
        <ProgressRule value={0.7} stalled labelledBy="rule-label" data-testid="held" />
      </>,
    );
    const fill = screen.getByTestId("held").firstElementChild as HTMLElement;
    // Held where it is, and visibly not the live tone.
    expect(fill.style.width).toBe("70%");
    expect(fill.className).toContain("transition-none");
    expect(fill.className).not.toContain("bg-ink ");
  });
});
