import { PlatformRequestError, platformRequest } from "@/lib/platformRequest";
import { clientRequestId } from "@/lib/randomId";

type Patch = Record<string, unknown>;
export type SettingsVersion = { revision: number; privateRevision?: number };
type Receipt = { requestId: string; state: string };

/** Administrator settings share the original command, revision and receipt contract. */
export class SiteSettingsCommand {
  constructor(private readonly ownerId = "") {}
  private get headers(): Record<string,string> { return this.ownerId ? {"X-Alcor-Expected-Account":this.ownerId} : {}; }
  private requestId?: string;
  private running?: Promise<void>;

  get pending() { return Boolean(this.requestId); }

  save(patch: Patch, password: string, code = "", expected?: SettingsVersion): Promise<void> {
    return this.running ??= this.perform(patch, password, code, expected).finally(() => { this.running = undefined; });
  }

  private accept(value: Receipt, identifier: string) {
    if (value?.requestId !== identifier || value.state !== "completed") {
      throw new Error("保存结果尚未确认，请稍后核对");
    }
    this.requestId = undefined;
  }

  private async perform(patch: Patch, password: string, code: string, expected?: SettingsVersion) {
    if (this.requestId) {
      const identifier = this.requestId;
      try {
        const receipt = await platformRequest<Receipt>(`/api/settings/operations/${identifier}`,{headers:this.headers});
        this.accept(receipt, identifier);
      } catch (error) {
        if (error instanceof PlatformRequestError && error.status === 404) {
          throw new Error("保存结果尚未确认，请稍后核对");
        }
        throw error;
      }
      return;
    }
    if (!password) throw new Error("请重新登录后完成网站设置");
    const current = expected ?? await platformRequest<SettingsVersion>("/api/settings",{headers:this.headers});
    if (!Number.isSafeInteger(current.revision) || current.revision < 0) {
      throw new Error("无法读取配置版本，请重试");
    }
    const identifier = clientRequestId();
    this.requestId = identifier;
    try {
      const saved = await platformRequest<{ requestId: string; operation?: Receipt; state?: string }>("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ ...patch, requestId: identifier, revision: current.revision, ...(current.privateRevision === undefined || Number.isInteger(patch.modelServicesRevision) ? {} : { privateRevision: current.privateRevision }), currentPassword: password, ...(code ? { code } : {}) }),
      });
      if (saved.requestId !== identifier) throw new Error("保存结果尚未确认，请稍后核对");
      this.accept(saved.operation ?? { requestId: saved.requestId, state: saved.state ?? "unknown" }, identifier);
    } catch (error) {
      // Only definitive refusals allow another command. Lost/5xx responses remain receipt-only.
      if (error instanceof PlatformRequestError && [400, 401, 403, 409, 422, 429].includes(error.status ?? 0)) {
        this.requestId = undefined;
      }
      throw error;
    }
  }
}
