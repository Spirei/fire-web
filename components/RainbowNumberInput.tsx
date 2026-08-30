"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  allowDecimal?: boolean;
  allowNegative?: boolean;
  grouping?: boolean;
};

function cleanNumber(value: string, allowDecimal: boolean, allowNegative: boolean) {
  const negative = allowNegative && /^\s*-/.test(value);
  const compact = value.replace(/,/g, "");
  const parts = compact.split(".");
  const integer = (parts.shift() || "").replace(/\D/g, "");
  const fraction = parts.join("").replace(/\D/g, "");
  const decimal = allowDecimal && compact.includes(".") ? `.${fraction}` : "";
  return `${negative ? "-" : ""}${integer}${decimal}`;
}

function formatNumber(value: string, grouping: boolean) {
  if (!value) return "";
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction] = unsigned.split(".");
  const grouped = grouping && integer ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : integer;
  return `${negative ? "-" : ""}${grouped}${value.includes(".") ? `.${fraction ?? ""}` : ""}`;
}

const RainbowNumberInput = forwardRef<HTMLInputElement, Props>(function RainbowNumberInput({
  allowDecimal = true, allowNegative = false, grouping = true, className = "", value,
  defaultValue, onChange, placeholder, inputMode, disabled, readOnly, style, ...props
}, ref) {
  void allowDecimal; void allowNegative; void grouping; void style;
  return <input {...props} ref={ref} type="number" value={value} defaultValue={defaultValue} onChange={onChange}
    placeholder={placeholder} inputMode={inputMode} disabled={disabled} readOnly={readOnly} className={className} />;
});

export default RainbowNumberInput;
