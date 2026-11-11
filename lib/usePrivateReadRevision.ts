"use client";
import { useEffect, useState } from "react";
import { PRIVATE_READ_EVENTS, privateReadEpoch } from "./privateReadContext";

export function usePrivateReadRevision() {
  const [version, setVersion] = useState(privateReadEpoch);
  useEffect(() => {
    const update = () => setVersion(privateReadEpoch());
    update();
    for (const event of PRIVATE_READ_EVENTS) window.addEventListener(event, update);
    return () => { for (const event of PRIVATE_READ_EVENTS) window.removeEventListener(event, update); };
  }, []);
  return version;
}
