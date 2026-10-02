"use client";

import { createElement, useState, useSyncExternalStore, type ComponentType } from "react";
import { preloadedView } from "@/lib/viewPreload";

const subscribe=()=>()=>{};
const clientSnapshot=()=>true;
const serverSnapshot=()=>false;

/** Pick once: cached code opens immediately; resolving later never remounts a live page. */
export default function preloadedWorkspace<P extends object|undefined>(key:string,deferred:ComponentType<P>):ComponentType<P> {
  function WorkspaceView(props:P) {
    // Hydration must use the same dynamic/Suspense tree as the server, even if code is cached.
    const clientMount=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
    const [View]=useState<ComponentType<P>>(()=>clientMount?(preloadedView(key) as ComponentType<P>|undefined)||deferred:deferred);
    return createElement(View as ComponentType<Exclude<P,undefined>>,props as Exclude<P,undefined>);
  }
  WorkspaceView.displayName=`WorkspaceView(${key})`;
  return WorkspaceView;
}
