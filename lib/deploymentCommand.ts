import { clientRequestId } from "@/lib/randomId";
import { PlatformRequestError, platformRequest } from "@/lib/platformRequest";

/** An ambiguous write is resolved by its original receipt, never by another write. */
export class DeploymentCommand {
  private id?: string;
  private running?: Promise<Record<string, unknown>>;
  constructor(private path: string, private method: string, private receipts: string, private retryAfterReceipt = false) {}
  get pending() { return Boolean(this.id); }
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
      // Explicit container retries may create a new request after a valid receipt.
      // Lost responses still recover the original UUID before another notification.
      if (this.retryAfterReceipt || !["queued", "running", "unknown", "dispatching"].includes(String(data.status))) this.id = undefined;
      return data;
    } catch (error) {
      if (!recovering && error instanceof PlatformRequestError && [400,401,403,409,422,429].includes(error.status ?? 0)) this.id = undefined;
      if (recovering && error instanceof PlatformRequestError && error.status === 404) throw Error("操作结果尚未确认，请稍后核对");
      throw error;
    }
  }
}
