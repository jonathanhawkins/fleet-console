import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/constants";
import { FLEET_UNITS } from "@/sim/engine";

/**
 * A metadata route is a route handler, and a handler in a static export has to
 * say so: without this Next refuses the build rather than guess that a
 * function with no dynamic reads in it is safe to run once. Nothing here reads
 * a request, so once is exactly right.
 */
export const dynamic = "force-static";

/**
 * Every route this export actually has: the fleet page, the gallery, and one
 * page per unit.
 *
 * The unit list comes from the roster rather than a second copy of it, for the
 * same reason `generateStaticParams` does — a ninth unit added to the sim is a
 * ninth static page, and it should be a ninth line here without anyone
 * remembering to add one. Build-time only, like every other read of the
 * engine from a route module.
 *
 * No `lastModified`: this repo does not track per-route modification dates,
 * and stamping the build time onto all ten would be a number that looks like
 * information and is not.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ["", "/system", ...FLEET_UNITS.map((unit) => `/unit/${unit.id}`)];
  return paths.map((path) => ({ url: `${SITE_URL}${path}` }));
}
