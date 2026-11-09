"use client";
import { IconX } from "@tabler/icons-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type AnchorHTMLAttributes,
} from "react";
export type CapsuleVariant = "primary" | "secondary" | "ghost" | "danger";
type Variant = CapsuleVariant;
/** Shared action/label contract: palette fill, readable ink, state and disabled treatment. */
export const Capsule = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    selected?: boolean;
    size?: "sm" | "md" | "lg";
    busy?: boolean;
  }
>(function Capsule(
  {
    variant = "primary",
    selected,
    size = "md",
    busy = false,
    disabled,
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
      data-capsule="off"
      data-capsule-variant={variant}
      data-size={size}
      aria-pressed={props["aria-pressed"] ?? selected}
      aria-busy={busy || props["aria-busy"]}
      disabled={disabled || busy}
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
    tone?: "neutral" | "danger";
  }
>(function IconButton(
  {
    label,
    selected,
    busy = false,
    size = "md",
    framed = false,
    tone = "neutral",
    disabled,
    title,
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
      title={title ?? label}
      aria-pressed={props["aria-pressed"] ?? selected}
      aria-busy={busy || props["aria-busy"]}
      disabled={disabled || busy}
      data-busy={busy || undefined}
      data-size={size}
      data-framed={framed || undefined}
      data-tone={tone}
      data-capsule="off"
      className={`capsule-icon-control ${className}`}
    />
  );
});

/** The same close control is used by modal headers and compact overlays. */
export function CloseButton(props: Omit<Parameters<typeof IconButton>[0], "label" | "children"> & {label?: string}) {
  return <IconButton {...props} label={props.label || "关闭"} size={props.size || "sm"}><IconX /></IconButton>;
}

export const CapsuleLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & {href: string; variant?: Variant; size?: "sm" | "md" | "lg"}>(function CapsuleLink({href,variant="primary",size="md",className="",...props},ref){
  return <a {...props} ref={ref} href={href} className={`capsule-control ${className}`} data-capsule-variant={variant} data-size={size}/>;
});

/** Links and buttons share the same compact, non-shrinking icon hit area. */
export const IconLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & {href: string; label: string; size?: "sm" | "md"; framed?: boolean}>(function IconLink({label,size="md",framed=false,className="",title,...props},ref){
  return <a {...props} ref={ref} aria-label={label} title={title ?? label} data-size={size} data-framed={framed || undefined} data-capsule="off" className={`capsule-icon-control ${className}`} />;
});
