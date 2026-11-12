import { clientRequestId } from "@/lib/randomId";
import { PlatformRequestError, platformRequest } from "@/lib/platformRequest";

export const deploymentPending = (status: unknown) => ["queued", "running", "unknown", "dispatching"].includes(String(status));

/** An ambiguous write is resolved by its original receipt, never by another write. */
export class DeploymentCommand {
  private id?: string;
  private running?: Promise<Record<string, unknown>>;
  constructor(private path: string, private method: string, private receipts: string) {}
  get pending() { return Boolean(this.id); }
  get requestId() { return this.id; }
  /** Restore only an authenticated server receipt; never replace an in-flight UUID. */
  observe(data: Record<string, unknown>) {
    if (typeof data.request_id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.request_id)
      || !["queued", "running", "unknown", "dispatching", "submitted", "succeeded", "failed", "rejected", "cancelled"].includes(String(data.status))
      || this.id && this.id !== data.request_id) return false;
    this.id = deploymentPending(data.status) ? data.request_id : undefined;
    return true;
  }
  execute<T extends Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
    return (this.running ??= this.perform(body).finally(() => { this.running = undefined; })) as Promise<T>;
  }
  private async perform(body: Record<string, unknown>) {
    const recovering = Boolean(this.id), id = this.id ?? clientRequestId();
    this.id = id;
    try {
      const data = await platformRequest<Record<string, unknown>>(recovering ? `${this.receipts}/${id}` : this.path, recovering ? {} : {
        method: this.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, request_id: id }),
      });
      if (!data || typeof data !== "object") throw Error("保存结果尚未确认，请稍后核对");
      if (this.path.endsWith('/config') ? typeof data.repository !== 'string' || typeof data.revision !== 'string' || typeof data.hasToken !== 'boolean' : typeof data.status !== 'string' || data.request_id !== id) {
        throw Error("操作结果尚未确认，请稍后核对");
      }
      if (this.path.endsWith('/config')) this.id = undefined;
      else if (!this.observe(data)) throw Error("操作结果尚未确认，请稍后核对");
      return data;
    } catch (error) {
      if (!recovering && error instanceof PlatformRequestError && [400,401,403,409,422,429].includes(error.status ?? 0)) this.id = undefined;
      if (recovering && error instanceof PlatformRequestError && error.status === 404) throw Error("操作结果尚未确认，请稍后核对");
      throw error;
    }
  }
}
