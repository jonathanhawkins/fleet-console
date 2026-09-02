import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
// The one place in the app allowed to reach for a shadcn primitive: this is the
// wrapper layer. Everything else imports from @/components/console (enforced by
// no-restricted-imports in eslint.config.mjs).
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Operator space: a pill. `primary` is the black pill from the hero reference — the
 * single dark accent on a warm-white page, used for the one action that matters
 * on a screen ("Run diagnostic").
 * Machine space: the same component goes square, mono and uppercase, because
 * --r-pill resolves to 0 there and the `machine:` variant tightens the metrics.
 * No space prop, no second component.
 */
export const consoleButtonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "rounded-pill border transition-colors duration-[var(--dur-micro)] ease-console",
    "disabled:pointer-events-none disabled:opacity-45",
    // the global :focus-visible outline is the focus treatment in both worlds;
    // silence the ring shadcn's base would add on top of it.
    "focus-visible:ring-0",
    "machine:tracking-[0.1em] machine:uppercase",
  ],
  {
    variants: {
      variant: {
        primary: [
          "border-transparent bg-ink text-bg shadow-[var(--elev-pill)]",
          "hover:bg-ink-hover",
        ],
        secondary: [
          "border-line-strong bg-bg text-ink shadow-[var(--elev-pill)]",
          "hover:bg-surface",
          "machine:bg-transparent machine:hover:bg-nominal-tint",
        ],
        ghost: [
          "border-transparent bg-transparent text-ink-soft",
          "hover:bg-surface hover:text-ink",
          "machine:hover:bg-transparent machine:hover:text-ink",
        ],
        danger: [
          "border-transparent bg-alert-tint text-alert-ink",
          "hover:bg-alert hover:text-bg",
          "machine:border-alert machine:bg-transparent",
        ],
      },
      size: {
        sm: "h-8 px-3.5 text-label machine:h-6 machine:px-2",
        md: "h-10 px-5 text-small machine:h-8 machine:px-3",
        lg: "h-12 px-7 text-body machine:h-9 machine:px-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ConsoleButtonProps
  extends React.ComponentProps<"button">, VariantProps<typeof consoleButtonVariants> {
  /** Render the child element instead of a `<button>` — e.g. a next/link `<Link>`. */
  asChild?: boolean;
}

export function ConsoleButton({
  className,
  variant,
  size,
  asChild,
  ...props
}: ConsoleButtonProps) {
  return (
    <Button
      asChild={asChild}
      data-console="button"
      data-variant={variant ?? "primary"}
      className={cn(consoleButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
