/**
 * The failed part, named the way a technician writes it on a work order.
 *
 * The wire says `actuator_A07`; a person says "actuator A-07". The hyphen is
 * not decoration — it is what separates the series letter from the number in
 * every place this part is written down, including the incident reference the
 * operator reads out on the phone.
 *
 * One function because two surfaces name the same part: the banner's one-line
 * verdict and the diagnostic panel's finding. Two transforms would eventually
 * disagree by a hyphen, and a report that calls it A-07 beside a card that
 * calls it A07 is a console that looks like it is describing two components.
 */
export function componentLabel(component: string): string {
  return component.replace(/_/g, " ").replace(/\b([A-Z])(\d+)\b/g, "$1-$2");
}

/** The same, opening a sentence or a headline. */
export function componentHeadline(component: string): string {
  const label = componentLabel(component);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
