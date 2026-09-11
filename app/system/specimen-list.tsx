import { SpecimenEntry } from "./library";
import { SPECIMENS } from "./specimens";

/**
 * The catalogue itself: every specimen, drawn in both spaces.
 *
 * Split from the gallery's header so the header can stay in the document and
 * this can arrive on its own — see specimen-library.tsx for why the list is
 * worth deferring and the header is not.
 */
export function SpecimenList() {
  return (
    <>
      {SPECIMENS.map((spec) => (
        <SpecimenEntry key={spec.name} spec={spec} />
      ))}
    </>
  );
}
