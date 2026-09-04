"use client";

import { forwardRef, useEffect, useRef, useState, type ChangeEvent, type CompositionEvent, type InputHTMLAttributes } from "react";

const CHAR_COLORS = ["#ff5f6d", "#ff8a4c", "#ffb84d", "#b58aff", "#8077ff", "#4ca9f5", "#37c7da", "#2bc9a5"];

type Props = InputHTMLAttributes<HTMLInputElement>;

const RainbowTextInput = forwardRef<HTMLInputElement, Props>(function RainbowTextInput({
  value,
  defaultValue,
  placeholder,
  className = "",
  onChange,
  onCompositionStart,
  onCompositionEnd,
  ...props
}, ref) {
  const composing = useRef(false);
  const [text, setText] = useState(() => String(value ?? defaultValue ?? ""));
  useEffect(() => {
    if (!composing.current) setText(String(value ?? defaultValue ?? ""));
  }, [value, defaultValue]);
  const emitChange = (input: HTMLInputElement) => {
    onChange?.({ target: input, currentTarget: input } as ChangeEvent<HTMLInputElement>);
  };
  return (
    <span className={`rainbow-text-field ${className}`}>
      <span className="rainbow-text-display" aria-hidden="true">
        <span className="rainbow-text-display-text">
          {text
            ? Array.from(text).map((char, index) => <span key={`c-${index}`} style={{ color: CHAR_COLORS[index % CHAR_COLORS.length] }}>{char}</span>)
            : <span className="rainbow-text-placeholder">{placeholder}</span>}
        </span>
      </span>
      <input
        {...props}
        ref={ref}
        value={text}
        placeholder=""
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="rainbow-text-native"
        onChange={(event) => {
          setText(event.target.value);
          if (!composing.current) emitChange(event.currentTarget);
        }}
        onCompositionStart={(event: CompositionEvent<HTMLInputElement>) => {
          composing.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event: CompositionEvent<HTMLInputElement>) => {
          composing.current = false;
          setText(event.currentTarget.value);
          emitChange(event.currentTarget);
          onCompositionEnd?.(event);
        }}
      />
    </span>
  );
});

export default RainbowTextInput;
