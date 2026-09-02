import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's stock scales. Our theme adds its own —
 * a six-step type scale that flips per space, and `rounded-pill` — and without
 * teaching the merger about them the failures are silent rather than loud:
 *
 *   cn("text-label", "text-ink-muted")  ->  "text-ink-muted"
 *        (text-label read as a colour and dropped; the type step vanishes)
 *   cn("rounded-lg", "rounded-pill")    ->  both survive, radius is a coin toss
 *
 * Both bit us on the first pass at ConsoleButton and SectionLabel. Registering
 * the groups here fixes every consumer at once.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "title", "heading", "body", "small", "label"] }],
      rounded: [{ rounded: ["pill"] }],
      tracking: [{ tracking: ["label", "heading"] }],
      ease: [{ ease: ["console", "descent"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
