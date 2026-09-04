import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OperatorCommand } from "@/lib/schema";
import { useIncidentStore } from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { STORYLINE_CHAPTERS } from "@/sim/engine";
import { setCommandTransport } from "./telemetry-command";
import { StorylineJump } from "./storyline-jump";

/**
 * The control that makes three quarters of the sim reachable.
 *
 * What it owes: one button per chapter the engine actually has (a chapter
 * added to the sim and forgotten here is a story that goes back to being
 * unwatchable), a real command on the wire, and the local half of the restart
 * — the client-owned incident history that no snapshot can clear.
 */

const sent: OperatorCommand[] = [];

const transport: TelemetryTransport = {
  connect: () => {},
  send: (cmd) => sent.push(cmd),
  disconnect: () => {},
};

beforeEach(() => {
  sent.length = 0;
  setCommandTransport(transport);
  useIncidentStore.getState().reset();
});

afterEach(() => setCommandTransport(null));

describe("jumping to a storyline chapter", () => {
  it("offers exactly the chapters the engine can seek to", () => {
    render(<StorylineJump />);
    const group = screen.getByRole("group", { name: /jump to/i });
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(STORYLINE_CHAPTERS.length);
  });

  it("names each chapter in words an operator would use", () => {
    render(<StorylineJump />);
    // Not "knee"/"nav"/"cohort"/"offset" — those are the engine's names.
    for (const label of [
      "Knee fault",
      "Blocked route",
      "Firmware cohort",
      "Ankle offset",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("sends the chapter and clears what the snapshot cannot", async () => {
    const user = userEvent.setup();
    render(<StorylineJump />);

    await user.click(screen.getByRole("button", { name: "Firmware cohort" }));

    expect(sent).toEqual([{ c: "SEEK_STORYLINE", chapter: "cohort" }]);
    expect(useIncidentStore.getState().history).toHaveLength(0);
  });

  it("says nothing on the wire when the link is not bound", async () => {
    setCommandTransport(null);
    const user = userEvent.setup();
    render(<StorylineJump />);

    await user.click(screen.getByRole("button", { name: "Blocked route" }));
    expect(sent).toHaveLength(0);
  });
});
