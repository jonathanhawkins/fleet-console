import Link from "next/link";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ConsoleButton,
  ConsoleCard,
  SectionLabel,
  StatusChip,
  consoleButtonVariants,
  consoleCardVariants,
  statusChipVariants,
} from "./index";

/**
 * jsdom has no Tailwind, so the *rendered* look of each space is verified in the
 * browser against /system (docs/evidence/phase-0). What is worth asserting here
 * is the contract: that a single component actually carries both grammars, and
 * that it behaves correctly as an interactive element.
 */

describe("StatusChip", () => {
  it("renders its label", () => {
    render(<StatusChip status="nominal">Nominal</StatusChip>);
    expect(screen.getByText("Nominal")).toBeInTheDocument();
  });

  it("exposes status on a data attribute for map/list querying", () => {
    render(<StatusChip status="alert">Alert</StatusChip>);
    expect(screen.getByText("Alert")).toHaveAttribute("data-status", "alert");
  });

  it("is quiet-tinted by default and inverts once the page descends", () => {
    const auto = statusChipVariants({ status: "alert", tone: "auto" });
    expect(auto).toContain("bg-alert-tint");
    expect(auto).toContain("text-alert");
    expect(auto).toContain("machine:bg-alert");
    expect(auto).toContain("machine:text-bg");
  });

  it("can be pinned to one grammar regardless of space", () => {
    expect(statusChipVariants({ status: "nominal", tone: "quiet" })).toContain(
      "bg-nominal-tint",
    );
    expect(statusChipVariants({ status: "nominal", tone: "quiet" })).not.toContain(
      "machine:bg-nominal",
    );

    const inverted = statusChipVariants({ status: "nominal", tone: "inverted" });
    expect(inverted).toContain("bg-nominal");
    expect(inverted).toContain("text-bg");
  });

  it("never carries a fixed radius — the pill token flattens it in machine space", () => {
    const cls = statusChipVariants({ status: "warn" });
    expect(cls).toContain("rounded-pill");
    expect(cls).not.toMatch(/rounded-(full|lg|md|sm)\b/);
  });
});

describe("ConsoleButton", () => {
  it("renders an accessible button and fires onClick", async () => {
    const onClick = vi.fn();
    render(<ConsoleButton onClick={onClick}>Run diagnostic</ConsoleButton>);

    const button = screen.getByRole("button", { name: "Run diagnostic" });
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", async () => {
    const onClick = vi.fn();
    render(
      <ConsoleButton disabled onClick={onClick}>
        Dispatch service
      </ConsoleButton>,
    );

    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("renders as its child element when asChild is set", () => {
    // next/link rather than a bare <a>: /unit/[id] is a real route now, and the
    // documented use of asChild is exactly this — a pill that navigates.
    render(
      <ConsoleButton asChild>
        <Link href="/unit/N-07">Open N-07</Link>
      </ConsoleButton>,
    );

    const link = screen.getByRole("link", { name: "Open N-07" });
    expect(link).toHaveAttribute("href", "/unit/N-07");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("wins the class conflict against the shadcn primitive it wraps", () => {
    render(<ConsoleButton variant="primary">Order</ConsoleButton>);
    const cls = screen.getByRole("button").className;

    // tailwind-merge must drop stock shadcn styling, not stack on top of it
    expect(cls).toContain("bg-ink");
    expect(cls).not.toContain("bg-primary");
    expect(cls).toContain("rounded-pill");
    expect(cls).not.toContain("rounded-lg");
  });

  it("is a pill in operator space and square, mono and uppercase in machine", () => {
    const cls = consoleButtonVariants({ variant: "primary", size: "lg" });
    expect(cls).toContain("rounded-pill");
    expect(cls).toContain("machine:uppercase");
    expect(cls).toContain("machine:h-9");
  });

  it("defers to the global focus outline instead of stacking a second ring", () => {
    expect(consoleButtonVariants({})).toContain("focus-visible:ring-0");
  });
});

describe("SectionLabel", () => {
  it("renders wide-tracked uppercase text from sentence-case source", () => {
    render(<SectionLabel>Fleet status</SectionLabel>);
    const label = screen.getByText("Fleet status");
    expect(label).toHaveClass("uppercase", "text-label");
  });

  it("hides the trailing rule from assistive tech", () => {
    const { container } = render(<SectionLabel rule>Subsystems</SectionLabel>);
    expect(container.querySelector("[aria-hidden]")).toBeInTheDocument();
  });

  it("can be promoted to a real heading element", () => {
    render(
      <SectionLabel as="h2" tone="alert">
        Incident
      </SectionLabel>,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Incident");
  });
});

describe("ConsoleCard", () => {
  it("renders children without a header when unlabelled", () => {
    const { container } = render(<ConsoleCard>Body</ConsoleCard>);
    expect(screen.getByText("Body")).toBeInTheDocument();
    expect(container.querySelector("header")).not.toBeInTheDocument();
  });

  it("renders a label row with an action slot", () => {
    render(
      <ConsoleCard
        label="Subsystems"
        action={<StatusChip status="warn">Warn</StatusChip>}
      >
        Body
      </ConsoleCard>,
    );
    expect(screen.getByText("Subsystems")).toBeInTheDocument();
    expect(screen.getByText("Warn")).toBeInTheDocument();
  });

  it("drops elevation and rounding in machine space", () => {
    const cls = consoleCardVariants({ variant: "raised" });
    expect(cls).toContain("shadow-[var(--elev-raised)]");
    expect(cls).toContain("machine:shadow-none");
    expect(cls).toContain("machine:rounded-none");
  });

  it("supports an unpadded variant for canvas-hosting panels", () => {
    expect(consoleCardVariants({ padding: "none" })).not.toContain("p-6");
  });
});
