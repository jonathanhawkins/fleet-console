import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/constants";

/**
 * A metadata route is a route handler, and a handler in a static export has to
 * say so: without this Next refuses the build rather than guess that a
 * function with no dynamic reads in it is safe to run once. Nothing here reads
 * a request, so once is exactly right.
 */
export const dynamic = "force-static";

/**
 * Nothing here is private, so nothing is disallowed.
 *
 * It exists mostly so that the one path every crawler probes before anything
 * else answers in two lines instead of serving the whole styled 404 document
 * and its JS.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
