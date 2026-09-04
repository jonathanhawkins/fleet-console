/**
 * What a report *is*, apart from what any one report says.
 *
 * There are two of them — the unit's write-up (incident-report-surface/) and
 * the fleet's (cohort-report-surface/) — and the thing an operator recognises
 * when the second one opens is not its content, it is its shape: full width,
 * one column of reading, a letterhead with a reference on it, sections ruled
 * and labelled the same way, and a generated-at line at the bottom. That shape
 * is a house style, and a house style that lives in two places is a house style
 * with a drift in it.
 *
 * So the chrome is held whole rather than approximated: the modal surface and
 * its focus discipline, the letterhead, the ruled section, the rail of moments,
 * the derived figure, the quotation, the tables and the colophon. Everything a
 * *particular* report knows — which journals it joins, what it is allowed to
 * conclude — stays in that report's own folder. Nothing here knows anything
 * about incidents at all.
 *
 * ## It is not in the console barrel
 *
 * Both documents are `next/dynamic` boundaries behind a click (the PRD's 200 KB
 * budget is the reason, stated in each of their gates), and this module is
 * theirs: it imports framer-motion and a page of layout, and re-exporting it
 * from `@/components/console` would invite an app-level import that put all of
 * it back into a route's initial payload.
 */
export { ReportShell } from "./shell";
export type { ReportShellProps } from "./shell";
export { ReportLetterhead } from "./letterhead";
export type { ReportLetterheadProps } from "./letterhead";
export { NotRecorded, ReportFigure, ReportMoments, ReportSection } from "./sections";
export type { ReportMoment } from "./sections";
export { ReportQuote, ReportTable, ReportTableHead } from "./quoting";
export { ReportFooter, useGeneratedAt } from "./colophon";
