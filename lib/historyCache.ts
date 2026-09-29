/** 公开历史数据：合并在途读取，完成值有界缓存；每个调用者取得独立副本。 */
export class HistoryCache<T> {
  private readonly values = new Map<string, { value: T; at: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(private readonly ttl = 600_000, private readonly capacity = 128) {}

  async fetch(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return structuredClone(hit.value);
    let task = this.pending.get(key);
    if (!task) {
      task = Promise.resolve().then(load).then(value => {
        const now = Date.now();
        for (const [oldKey, entry] of this.values) {
          if (now - entry.at >= this.ttl) this.values.delete(oldKey);
        }
        this.values.delete(key);
        while (this.values.size >= this.capacity) this.values.delete(this.values.keys().next().value!);
        this.values.set(key, { value, at: now });
        return value;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    return structuredClone(await task);
  }
}
