/** LRU codec ownership within one media worker. Pinned decoders cannot be
 * evicted while servicing an exact-frame request or a streaming transcode. */
export class DecoderBudget {
  private entries = new Map<string, {close: () => void; pinned: boolean}>();
  constructor(readonly limit = 4) {
    if (!Number.isInteger(limit) || limit < 1) throw Error('Invalid decoder budget');
  }
  use(key: string, close: () => void, pinned = false): boolean {
    const old = this.entries.get(key);
    if (old) this.entries.delete(key);
    else if (this.entries.size >= this.limit) {
      const victim = [...this.entries].find(([,entry]) => !entry.pinned);
      if (!victim) return false;
      this.entries.delete(victim[0]); victim[1].close();
    }
    this.entries.set(key,{close,pinned}); return true;
  }
  unpin(key: string) { const entry=this.entries.get(key); if(entry)entry.pinned=false; }
  release(key: string) { this.entries.delete(key); }
  get size() { return this.entries.size; }
}
