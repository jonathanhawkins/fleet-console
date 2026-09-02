import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DISCLAIMER } from "@/lib/constants";
import {
  CONNECTION_STATES,
  ConnectionStatus,
  type ConnectionState,
} from "./connection-status";
import { ConsoleCard } from "./console-card";
import { ConsoleFooter } from "./console-footer";
import { ConsoleHeader } from "./console-header";
import { ProductMark } from "./product-mark";
import { StatGroup } from "./stat-group";

/**
 * The shell's contract, as opposed to its look: that the disclaimer cannot go
 * missing, that no KPI ever renders an invented number, and that a connection
 * state change is something assistive tech is told about rather than shown.
 * The rendered result is verified in the browser (docs/evidence/phase-1).
 */

describe("ConnectionStatus", () => {
  it("defaults to idle — nothing has tried to connect yet", () => {
    render(<ConnectionStatus />);
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "idle");
  });

  it("renders operator copy for every state it accepts", () => {
    const copy: Record<ConnectionState, string> = {
      idle: "Idle",
      connecting: "Connecting",
      live: "Live",
      lost: "Connection lost",
    };

    for (const state of CONNECTION_STATES) {
      const { unmount } = render(<ConnectionStatus state={state} />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("data-state", state);
      expect(status).toHaveTextContent(copy[state]);
      unmount();
    }
  });

  it("announces politely and names what is connecting", () => {
    render(<ConnectionStatus state="live" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/Telemetry connection:\s*Live/);
  });

  it("colours the dot, not the word — except when the link is lost", () => {
    const { unmount } = render(<ConnectionStatus state="live" />);
    expect(screen.getByRole("status")).toHaveClass("text-ink-soft");
    unmount();

    render(<ConnectionStatus state="lost" />);
    expect(screen.getByRole("status")).toHaveClass("text-alert-ink");
  });
});

describe("StatGroup", () => {
  it("renders an em-dash rather than a plausible number when pending", () => {
    render(
      <dl>
        <StatGroup label="Units nominal" pending />
      </dl>,
    );

    expect(screen.getByText("Units nominal")).toBeInTheDocument();
    expect(screen.getByText("—")).toHaveAttribute("aria-hidden");
    expect(screen.getByText("No data yet")).toBeInTheDocument();
  });

  it("renders value and unit once real data arrives", () => {
    render(
      <dl>
        <StatGroup label="Avg battery" value="78" unit="%" />
      </dl>,
    );

    const value = screen.getByText("78");
    expect(value).toHaveTextContent("78");
    expect(screen.getByText("%")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("keeps figures in tabular numerals so a fleet column lines up", () => {
    render(
      <dl>
        <StatGroup label="Active alerts" value="3" tone="alert" />
      </dl>,
    );
    const dd = screen.getByText("3");
    expect(dd).toHaveClass("tnum", "text-alert-ink");
  });

  /**
   * The first reading is acknowledged, and the acknowledgement is a *step on
   * one element*, not an element swap. A CSS transition is bound to a
   * DOM node: the day someone gives the two branches different keys, or wraps
   * the figure in its own span, the beat disappears with no test failing and
   * no visible breakage — which is exactly the kind of regression that never
   * gets found. So the assertion is node identity, not a class list.
   */
  it("inks the first figure in on the same element the em-dash was on", () => {
    const { rerender } = render(
      <dl>
        <StatGroup label="Avg battery" pending />
      </dl>,
    );

    const dd = screen.getByText("No data yet").parentElement;
    expect(dd).toHaveClass("text-ink-muted");

    rerender(
      <dl>
        <StatGroup label="Avg battery" value="78" unit="%" />
      </dl>,
    );

    expect(screen.getByText("78")).toBe(dd);
    expect(dd).toHaveClass("text-ink");
    expect(dd).not.toHaveClass("text-ink-muted");
  });
});

describe("ConsoleHeader", () => {
  it("carries our own mark, linked home", () => {
    render(<ConsoleHeader />);
    const mark = screen.getByRole("link", { name: /fleet console/i });
    expect(mark).toHaveAttribute("href", "/");
  });

  it("labels the data as simulated on every page that uses it", () => {
    render(<ConsoleHeader />);
    expect(screen.getByText("Simulated data")).toBeInTheDocument();
  });

  it("renders its children as the trailing cluster", () => {
    render(
      <ConsoleHeader>
        <ConnectionStatus state="connecting" />
      </ConsoleHeader>,
    );
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("status")).toHaveTextContent("Connecting");
  });
});

describe("ProductMark", () => {
  it("is typographic only — no image, no borrowed logo", () => {
    const { container } = render(<ProductMark />);
    expect(container.querySelector("img, svg")).toBeNull();
    expect(screen.getByRole("link")).toHaveAccessibleName("Fleet Console");
  });
});

describe("ConsoleFooter", () => {
  it("states the disclaimer verbatim", () => {
    render(<ConsoleFooter />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(DISCLAIMER);
  });
});

describe("ConsoleCard as a shell region", () => {
  it("promotes its label to a heading when it names a region", () => {
    render(
      <ConsoleCard label="Fleet map" labelAs="h2" padding="none">
        body
      </ConsoleCard>,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Fleet map");
  });
});
