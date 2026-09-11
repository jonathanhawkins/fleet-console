import { afterEach, describe, expect, it, vi } from "vitest";
import { type OperatorCommand } from "@/lib/schema";
import { type IncidentRecord } from "@/lib/stores/incidentStore";

/**
 * The chain fires on one event — the knee's incident being filed — and on
 * nothing else. It is exercised through a freshly imported module graph so the
 * build-time switch can be tested too: the flag is read once, at load.
 */

const knee = {
  id: "inc-N-07-1",
  unitId: "N-07",
  report: {
    unitId: "N-07",
    ts: 1,
    joint: "knee_L",
    component: "actuator_A07",
    anomaly: "gain",
  },
  acknowledged: [],
  startedAt: 0,
  channels: [],
} as unknown as IncidentRecord;

const clean = {
  ...knee,
  id: "inc-N-04-1",
  unitId: "N-04",
  report: { ...knee.report, unitId: "N-04", anomaly: "none" },
} as unknown as IncidentRecord;

async function fresh() {
  vi.resetModules();
  const chain = await import("./storyline-chain");
  const stores = await import("@/lib/stores");
  const sent: OperatorCommand[] = [];
  const unbind = chain.bindStorylineChain((cmd) => {
    sent.push(cmd);
    return true;
  });
  const file = (record: IncidentRecord) =>
    stores.useIncidentStore.setState((s) => ({ history: [record, ...s.history] }));
  return { sent, unbind, file };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the storyline chain", () => {
  it("pulls the cohort forward the moment the knee's incident is filed, and only then", async () => {
    const { sent, unbind, file } = await fresh();

    file(clean);
    expect(sent).toEqual([]);

    file(knee);
    expect(sent).toEqual([{ c: "ADVANCE_STORYLINE", chapter: "cohort" }]);

    unbind();
    file({ ...knee, id: "inc-N-07-2" } as IncidentRecord);
    expect(sent).toHaveLength(1);
  });

  it("stays off when the build says so", async () => {
    vi.stubEnv("NEXT_PUBLIC_SIM_CHAIN", "0");
    const { sent, unbind, file } = await fresh();
    file(knee);
    expect(sent).toEqual([]);
    unbind();
  });
});
