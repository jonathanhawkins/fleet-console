import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as console_ from "@/components/console";
import { SPECIMENS } from "./specimens";
import SystemPage from "./page";

/**
 * The gallery's two contracts.
 *
 * `/system` is the library's documentation, and documentation drifts silently:
 * a component added to the barrel and forgotten here leaves the page claiming
 * to document a library it only half covers. So the coverage is asserted, not
 * remembered — this is the test that failed when the page showed four of
 * thirteen components.
 *
 * The second contract is the document outline. Both space sections open with a
 * display headline, which is how the page came to ship two `h1` elements; the
 * masthead is the only one now.
 */

/**
 * The barrel's components: exported, capitalised, callable, and not a constant.
 * Hooks and helpers are lower-case by convention and token bundles are
 * SCREAMING_CASE, so the shape of the name is enough to tell them apart.
 */
function exportedComponents(): string[] {
  return Object.entries(console_)
    .filter(
      ([name, value]) =>
        typeof value === "function" &&
        /^[A-Z][a-z]/.test(name) &&
        name !== name.toUpperCase(),
    )
    .map(([name]) => name)
    .sort();
}

describe("the design-system gallery", () => {
  it("documents every component the console barrel exports", () => {
    const documented = SPECIMENS.map((s) => s.name).sort();
    expect(documented).toEqual(exportedComponents());
  });

  it("gives every entry the things a caller needs", () => {
    for (const spec of SPECIMENS) {
      expect(spec.purpose, `${spec.name} purpose`).toBeTruthy();
      // The usage line must be a real call to the component it documents.
      expect(spec.usage, `${spec.name} usage`).toContain(`<${spec.name}`);
      // Props are allowed to be empty — that is a claim too ("only the
      // element's own props") — but the field has to be deliberate.
      expect(Array.isArray(spec.props), `${spec.name} props`).toBe(true);
      for (const row of spec.props) {
        expect(row.name, `${spec.name}.${row.name}`).toBeTruthy();
        expect(row.type, `${spec.name}.${row.name} type`).toBeTruthy();
        expect(row.note, `${spec.name}.${row.name} note`).toBeTruthy();
      }
    }
  });

  it("is one document with one h1", () => {
    render(<SystemPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("offers a way back to the fleet", () => {
    render(<SystemPage />);
    expect(screen.getByRole("link", { name: /back to the fleet/i })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("draws each specimen in both spaces from the same element", () => {
    const { container } = render(<SystemPage />);
    const frames = container.querySelectorAll("[data-space='machine']");
    // One per specimen, plus the machine-space section itself.
    expect(frames.length).toBeGreaterThanOrEqual(SPECIMENS.length);
  });
});
