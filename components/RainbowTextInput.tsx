"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

const CHAR_COLORS = ["#ff5f6d", "#ff8a4c", "#ffb84d", "#b58aff", "#8077ff", "#4ca9f5", "#37c7da", "#2bc9a5"];

type Props = InputHTMLAttributes<HTMLInputElement>;

const RainbowTextInput = forwardRef<HTMLInputElement, Props>(function RainbowTextInput({ value, defaultValue, placeholder, className = "", ...props }, ref) {
  const text = String(value ?? defaultValue ?? "");
  return (
    <span className={`rainbow-text-field ${className}`}>
      <span className="rainbow-text-display" aria-hidden="true">
        {text ? Array.from(text).map((char, index) => <span key={`${index}-${char}`} style={{ color: CHAR_COLORS[index % CHAR_COLORS.length] }}>{char}</span>) : <span className="rainbow-text-placeholder">{placeholder}</span>}
      </span>
      <input {...props} ref={ref} value={value} defaultValue={defaultValue} placeholder="" className="rainbow-text-native" />
    </span>
  );
});

export default RainbowTextInput;
