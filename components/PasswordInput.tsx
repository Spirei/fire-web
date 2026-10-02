"use client";

import { useEffect, useId, useState, type InputHTMLAttributes, type Ref } from "react";
import VisibilityIcon from "@/components/VisibilityIcon";

/** Reveals only the current draft; never retrieves saved credentials. */
export default function PasswordInput({ id, disabled, readOnly, ref, allowReveal = true, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement>; allowReveal?: boolean }) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [visible, setVisible] = useState(false);
  const canReveal = allowReveal && !disabled && !readOnly;
  const shown = visible && canReveal;
  useEffect(() => { if (disabled || readOnly || props.value === "") setVisible(false); }, [disabled, readOnly, props.value]);
  return <span className="password-input" data-reveal={allowReveal ? undefined : "false"}>
    <input {...props} id={inputId} ref={ref} aria-label={props["aria-label"] || props.placeholder || "密码"} disabled={disabled} readOnly={readOnly} type={shown ? "text" : "password"} className={`password-input-control ${props.className || ""}`} />
    {canReveal && <button type="button" className="password-visibility-toggle" aria-label={shown ? "隐藏密码" : "显示密码"} title={shown ? "隐藏密码" : "显示密码"} aria-pressed={shown} aria-controls={inputId} onMouseDown={event => event.preventDefault()} onClick={() => setVisible(value => !value)}>
      <VisibilityIcon hidden={shown} />
    </button>}
  </span>;
}
