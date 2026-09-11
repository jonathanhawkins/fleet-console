// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DIAG_WALK_PATHS } from "@/sim/engine/diagnostics";
import { MANIFEST_ROWS } from "@/lib/diagnostics/manifest-spec";
import { type DiagSession } from "@/lib/stores";
import { StructureList, STRUCTURE_ORDER } from "./structure-list";

/**
 * The nine subsystems, and the claim the count is making.
 *
 * The order assertion is the one that matters most. The grid is meant to fill
 * top-to-bottom as the walk clears it, and it only does that if the order
 * written here is the order the simulator actually walks. Nothing in the app
 * imports that array — it would drag the engine into the unit page's bundle —
 * so this is the joint that holds the two together.
 */

const session = (walkLines: string[]): DiagSession => ({
  unitId: "N-07",
  startedAt: 0,
  walkLines,
  channels: [],
  flag: null,
  report: null,
  acknowledged: [],
  calibration: null,
});

/** Where in the walk each structure row earns its check. */
function clearsAt(id: string): number {
  const row = MANIFEST_ROWS.find((r) => r.id === id)!;
  if (row.path) return DIAG_WALK_PATHS.indexOf(row.path);
  // A prefix row clears on its nth matching node.
  const matches = DIAG_WALK_PATHS.filter((p) => p.startsWith(row.prefix!));
  return DIAG_WALK_PATHS.indexOf(matches[(row.count ?? 1) - 1]!);
}

describe("the reading order is the order the scan clears them", () => {
  it("lists every structure row the manifest has, and no others", () => {
    const structure = MANIFEST_ROWS.filter((r) => r.group === "structure").map(
      (r) => r.id,
    );
    expect([...STRUCTURE_ORDER].sort()).toEqual([...structure].sort());
  });

  it("fills top to bottom rather than skipping around", () => {
    const positions = STRUCTURE_ORDER.map(clearsAt);
    expect(positions.every((n) => n >= 0)).toBe(true);
    const ascending = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(ascending);
  });
});

describe("StructureList", () => {
  it("stands all nine rows up pending before the walk starts", () => {
    render(<StructureList session={session([])} />);
    const rows = document.querySelectorAll("[data-structure]");
    expect(rows).toHaveLength(9);
    for (const row of rows) expect(row.getAttribute("data-state")).toBe("pending");
    expect(screen.getByText(/0 of 9 checked/)).toBeVisible();
  });

  it("checks a row when the walk reaches its node, and counts it", () => {
    render(<StructureList session={session(["/sys/core/heartbeat.svc"])} />);
    const row = document.querySelector('[data-structure="HEARTBEAT_SVC"]')!;
    expect(row.getAttribute("data-state")).toBe("checked");
    expect(within(row as HTMLElement).getByText("checked")).toBeInTheDocument();
    expect(screen.getByText(/1 of 9 checked/)).toBeVisible();
  });

  it("counts the calibration tables as a fraction rather than six rows", () => {
    const calib = DIAG_WALK_PATHS.filter((p) => p.startsWith("/calib/")).slice(0, 4);
    render(<StructureList session={session(calib)} />);
    const row = document.querySelector('[data-structure="GAIN_TABLES"]')!;
    expect(row.textContent).toContain("4/6");
    expect(row.getAttribute("data-state")).toBe("pending");
  });

  it("says a pending row is pending to a screen reader without drawing a chip", () => {
    render(<StructureList session={session([])} />);
    const row = document.querySelector('[data-structure="IMU_FUSION"]')!;
    expect(within(row as HTMLElement).getByText("not yet checked")).toBeInTheDocument();
    // No status chips: nine of them would out-shout the finding.
    expect(row.querySelector('[data-slot="status-chip"]')).toBeNull();
  });

  it("keeps the twenty walked paths behind a disclosure, verbatim", async () => {
    const walked = [...DIAG_WALK_PATHS];
    render(<StructureList session={session(walked)} />);

    const toggle = screen.getByRole("button", { name: "Subsystem walk" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: /Hide subsystem walk/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The wire's own strings, not translated.
    expect(screen.getByText(walked[0]!)).toBeVisible();
    expect(screen.getByText(walked.at(-1)!)).toBeVisible();
    expect(screen.getByText("0001")).toBeVisible();
  });
});
