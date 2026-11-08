"use client";
import { type ReactNode, type ButtonHTMLAttributes } from "react";
import { Capsule } from "./Capsule";

/** Clickable summaries share one bounded layout and a restrained palette indicator. */
export default function MetricButton({label,value,icon,selected,...props}: Omit<ButtonHTMLAttributes<HTMLButtonElement>,"children"> & {label:string;value:number;icon:ReactNode;selected?:boolean}) {
  return <Capsule {...props} variant="ghost" selected={selected} className="metric-control" aria-label={`${label}，${value.toLocaleString("zh-CN")}`}><span>{icon}{label}</span><strong>{value.toLocaleString("zh-CN")}</strong></Capsule>;
}
