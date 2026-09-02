"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A section that opens and closes, at the volume of the rest of operator space.
 *
 * Two rules it exists to keep, both of which are easy to get wrong once and
 * then repeat in every place a panel opens:
 *
 * **The travel is CSS, so it is interruptible for free.** `grid-template-rows`
 * from `0fr` to `1fr` is the one way to animate to an intrinsic height without
 * measuring anything, and because it is a transition rather than a keyframed
 * animation, a click landing mid-open reverses from the pixel on screen instead
 * of snapping to an end state and starting over. It also inherits the
 * stylesheet's global `prefers-reduced-motion` clamp (transition-duration: 0s),
 * so an operator who asked for stillness gets an instant open with no branch
 * here.
 *
 * **It stays mounted, so closing is a motion and not a disappearance.** The
 * wrapper is always in the tree; only its contents are lazy, and only until the
 * first open. That is what makes the collapse animate at all — an unmount has
 * no exit — and it costs one empty div per collapsed section, which is the
 * cheapest possible way to buy a symmetric beat. The alert feed leans on this:
 * a hundred rows carry a hundred empty wrappers and zero store subscriptions
 * until one is opened.
 *
 * Closed content is `inert`, which is the part that is not decoration. A panel
 * clipped to zero height is still in the accessibility tree and still
 * focusable; a keyboard operator tabbing through a collapsed feed would walk
 * into links they cannot see. `inert` takes the whole subtree out of both.
 */
export interface DisclosureProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children"
> {
  open: boolean;
  children: React.ReactNode;
}

export function Disclosure({ className, open, children, ...props }: DisclosureProps) {
  // Adjusted during render rather than in an effect (the pattern React
  // documents, and the one BannerReveal uses): the contents have to exist in
  // the same commit that starts the travel, or the first frame animates an
  // empty box to the height of nothing.
  const [seen, setSeen] = React.useState(open);
  if (open && !seen) setSeen(true);

  return (
    <div
      data-slot="disclosure"
      data-open={open || undefined}
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows] duration-[var(--dur-enter)] ease-console",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "overflow-hidden transition-opacity duration-[var(--dur-enter)] ease-console",
          open ? "opacity-100" : "opacity-0",
        )}
      >
        {seen ? children : null}
      </div>
    </div>
  );
}
