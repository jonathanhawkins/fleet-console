import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DISCLAIMER } from "./constants";
import { cn } from "./utils";

describe("toolchain smoke", () => {
  it("renders a component through jsdom + testing-library", () => {
    render(<p data-testid="smoke">{DISCLAIMER}</p>);
    expect(screen.getByTestId("smoke")).toHaveTextContent("All data is simulated");
  });

  it("resolves conflicting tailwind classes last-wins via tailwind-merge", () => {
    expect(cn("rounded-lg", "rounded-full")).toBe("rounded-full");
    expect(cn("px-2", false && "px-8", "px-6")).toBe("px-6");
  });

  it("knows our custom scales, so a type step is never mistaken for a colour", () => {
    // regression: text-label was being read as a colour and dropped
    expect(cn("text-label", "text-ink-muted")).toBe("text-label text-ink-muted");
    expect(cn("text-sm", "text-small")).toBe("text-small");
    expect(cn("text-body", "text-label")).toBe("text-label");

    // regression: rounded-pill did not displace shadcn's rounded-lg
    expect(cn("rounded-lg", "rounded-pill")).toBe("rounded-pill");
    expect(cn("rounded-pill", "rounded-none")).toBe("rounded-none");
  });
});
