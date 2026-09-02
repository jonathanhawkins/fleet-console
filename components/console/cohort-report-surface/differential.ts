/** What a single-build cohort is consistent with, cheapest to establish first. */
export const FLEET_DIFFERENTIAL = {
  consistentWith: [
    "a regression in the rolled-out build",
    "a change these units share off-build",
    "independent faults of the same kind",
  ],
  recommended: "roll the cohort back before dispatching anyone.",
} as const;

/** The differential's closing line: a label, and the clause after the colon. */
export interface FleetDifferentialStance {
  label: string;
  text: string;
}

/** Open: an instruction. Closed: the result of the cheapest test — consistent with, never proof. */
export function fleetDifferentialStance(
  /** Every member is off the suspect build. */
  restored: boolean,
  /** A rollback was ordered, so the first candidate was tested. */
  rolledBack: boolean,
  fw: string,
): FleetDifferentialStance {
  if (!restored) return { label: "Recommended", text: FLEET_DIFFERENTIAL.recommended };
  if (!rolledBack) {
    return {
      label: "Untested",
      text: `the affected units came off ${fw} with no rollback on file, so the first candidate was never put to the test.`,
    };
  }
  return {
    label: "Tested",
    text: `the cohort was rolled back and every alert cleared with the build. That is what a regression in ${fw} predicts; it does not rule the other two out.`,
  };
}
