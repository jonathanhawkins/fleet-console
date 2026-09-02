import Link from "next/link";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConsoleButton } from "./console-button";
import { ConsoleCard } from "./console-card";
import { SectionLabel } from "./section-label";
import { StatusChip } from "./status-chip";

/**
 * jsdom has no Tailwind, so the *rendered* look of each space is verified in the
 * browser against /system. What is worth asserting here is the contract: that
 * a component behaves correctly as an interactive element and does not keep
 * the stock primitive's styling — not which utilities it happens to emit.
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
    expect(cls).not.toContain("bg-primary");
    expect(cls).not.toContain("rounded-lg");
  });
});

describe("SectionLabel", () => {
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
});
