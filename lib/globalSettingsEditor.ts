"use client";
import { SiteSettingsCommand, type SettingsVersion } from "./siteSettingsCommand";
import { platformRequest } from "./platformRequest";
import { requestAdminProof } from "./adminProof";
import type { SiteSettings } from "./types";

/** Reorder visible entries while retaining hidden/unknown entries in the shared configuration. */
export function mergeVisibleOrder(current: string[], desired: string[]): string[] {
  const wanted=[...new Set(desired)], selected=new Set(wanted); let cursor=0;
  const result=current.map(key => selected.has(key) ? wanted[cursor++] : key);
  return [...new Set([...result,...wanted.slice(cursor)])];
}
export class GlobalSettingsEditor {
  private readonly command: SiteSettingsCommand;
  private running=false;
  constructor(private readonly ownerId="") { this.command=new SiteSettingsCommand(ownerId); }
  get busy() { return this.running; }
  async save(patch: Partial<SiteSettings> | ((current: SiteSettings) => Partial<SiteSettings>)) {
    if (this.running) throw Error("正在保存，请稍后再操作");
    this.running=true;
    try {
      const recovered=this.command.pending;
      const headers:Record<string,string>=this.ownerId?{"X-Alcor-Expected-Account":this.ownerId}:{};
      const current=await platformRequest<SettingsVersion & {settings:SiteSettings}>("/api/settings",{headers});
      const proof=recovered?{password:"",code:""}:await requestAdminProof();
      if (!proof) return null;
      const desired=typeof patch==="function"?patch(current.settings):patch;
      await this.command.save(desired,proof.password,proof.code,current);
      const saved=await platformRequest<{settings:SiteSettings}>("/api/settings",{headers});
      const layoutKeys=new Set(["markets","assetMarketOrder","assetAnalysisOrder"]);
      window.dispatchEvent(new CustomEvent("fire:settings-updated",{detail:{dataChanged:Object.keys(desired).some(key=>!layoutKeys.has(key))}}));
      return {settings:saved.settings,recovered};
    } finally { this.running=false; }
  }
}
