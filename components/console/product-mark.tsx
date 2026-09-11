import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Our own mark, and deliberately only type.
 *
 * The reference world's identity is carried almost entirely by typography — a
 * wordmark set small, uppercase and wide-tracked, with the trailing word
 * dropped a tone. That is the gesture worth borrowing; the logo itself is not
 * ours to borrow, and no third-party asset appears anywhere in this app.
 *
 * It says *Robot* Fleet Console because the first thing a stranger needs from a
 * masthead is the subject. "Fleet Console" alone could be trucks, servers or
 * ships, and a reader who has to infer what they are looking at from a map of
 * house names spends the first thirty seconds solving the wrong problem.
 *
 * Set one step above the nav labels around it (text-small vs text-label) so it
 * reads as a mark rather than a fourth menu item. Machine space squares and
 * re-tracks it through the token layer, without a prop.
 */
export interface ProductMarkProps {
  /** Where the mark navigates. The fleet page by default. */
  href?: string;
  className?: string;
}

export function ProductMark({ href = "/", className }: ProductMarkProps) {
  return (
    // inline-block, not inline-flex: a flex container drops the whitespace text
    // node between the two words and the mark renders as "FLEETCONSOLE".
    <Link
      href={href}
      data-slot="product-mark"
      className={cn(
        "group inline-block rounded-sm text-small tracking-label uppercase",
        className,
      )}
    >
      <span className="font-medium text-ink">Robot Fleet</span>{" "}
      <span className="text-ink-soft transition-colors duration-[var(--dur-press)] ease-console group-hover:text-ink group-active:text-ink">
        Console
      </span>
    </Link>
  );
}
