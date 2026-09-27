"use client";

import { usePathname } from "next/navigation";

/** Also scopes body-portalled detail dialogs. Never applies to the homepage. */
export default function CapsuleScope() {
  const pathname = usePathname();
  return pathname && pathname !== "/" ? <span hidden aria-hidden="true" data-capsule-scope="non-home" /> : null;
}
