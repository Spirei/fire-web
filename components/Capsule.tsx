"use client";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from "react";
type Variant = "primary" | "secondary";
/** Shared action/label contract: palette fill, readable ink, state and disabled treatment. */
export const Capsule = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    selected?: boolean;
  }
>(function Capsule(
  {
    variant = "primary",
    selected = false,
    className = "",
    type = "button",
    onClick,
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      onClick={onClick}
      ref={ref}
      type={type}
      className={`capsule-control ${className}`}
      data-capsule-variant={variant}
      data-selected={selected || undefined}
    />
  );
});
export function CapsuleBadge({
  variant = "primary",
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: Variant;
}) {
  return (
    <span
      {...props}
      className={`capsule-badge ${className}`}
      data-capsule-variant={variant}
    />
  );
}

/** Shared icon control for collection toolbars and compact actions. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    selected?: boolean;
    busy?: boolean;
    size?: "sm" | "md";
    framed?: boolean;
  }
>(function IconButton(
  {
    label,
    selected = false,
    busy = false,
    size = "md",
    framed = false,
    className = "",
    type = "button",
    onClick,
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={selected || undefined}
      aria-busy={busy || undefined}
      data-busy={busy || undefined}
      data-size={size}
      data-framed={framed || undefined}
      data-capsule="off"
      className={`capsule-icon-control ${className}`}
    />
  );
});
