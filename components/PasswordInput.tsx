"use client";

import { useEffect, useId, useState, type InputHTMLAttributes, type Ref } from "react";

/** Reveals only the current draft; never retrieves saved credentials. */
export default function PasswordInput({ id, disabled, readOnly, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [visible, setVisible] = useState(false);
  const canReveal = !disabled && !readOnly;
  const shown = visible && canReveal;
  useEffect(() => { if (disabled || readOnly || props.value === "") setVisible(false); }, [disabled, readOnly, props.value]);
  return <span className="password-input">
    <input {...props} id={inputId} ref={ref} aria-label={props["aria-label"] || props.placeholder || "密码"} disabled={disabled} readOnly={readOnly} type={shown ? "text" : "password"} className={`password-input-control ${props.className || ""}`} />
    {canReveal && <button type="button" className="password-visibility-toggle" aria-label={shown ? "隐藏密码" : "显示密码"} title={shown ? "隐藏密码" : "显示密码"} aria-pressed={shown} aria-controls={inputId} onMouseDown={event => event.preventDefault()} onClick={() => setVisible(value => !value)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7Z" /><circle cx="12" cy="12" r="3" />{shown && <path d="m3 3 18 18" />}</svg>
    </button>}
  </span>;
}
