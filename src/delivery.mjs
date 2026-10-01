import { createHash } from 'node:crypto';
import { readSession, sendNative } from './adapters.mjs';

export const eligible = m => m.final || m.role === 'user' || m.event;
export const eventKey = m => `${m.id}:${m.final ? 'final' : m.role}`;
export function eventId(...parts) {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

const RETRY_MS = 60000, MAX_FAILURES = 3, GIVE_UP_MS = 24 * 3600000, RECHECK_MS = 30000;

export class Delivery {
  constructor(store, read = readSession, transmit = sendNative) { this.store = store; this.read = read; this.transmit = transmit; this.recheckAt = 0; }
  observe(target, snapshot) {
    if (snapshot.pauseKey && snapshot.pauseKey !== target.resumeKey && target.state === 'active') {
      return this.store.control(target.alias, 'paused', snapshot.pauseKey);
    }
    return target;
  }
  async submit(destination, body, id, source = null) {
    const old = this.store.reserve(id, destination, body, source);
    if (!old.duplicate) await this.deliver(id);
    return { ...this.store.result(this.store.delivery(id)), duplicate: old.duplicate };
  }
  enqueueEvent(source, destination, key, text) {
    const id = eventId(source, destination, key);
    this.store.reserve(id, destination, `[Agent talk event ${id} from ${source}]\n${text}`, source);
    return id;
  }
  async deliver(id) {
    const row = this.store.delivery(id);
    if (!row || row.state !== 'queued') return;
    let target = this.store.get(row.destination);
    if (row.source) {
      const follow = this.store.db.prepare('SELECT * FROM follows WHERE source=?').get(row.source);
      if (!follow?.enabled || follow.destination !== row.destination || this.store.get(row.source).state === 'completed') {
        this.store.queuedReceipt(id, { state: 'cancelled', detail: '自动回传已关闭' }); return;
      }
    }
    if (target.state !== 'active') {
      if (target.state === 'completed') this.store.queuedReceipt(id, { state: 'cancelled' });
      return;
    }
    let snapshot;
    try { snapshot = await this.read(target); }
    catch { this.store.queuedReceipt(id, { state: 'queued', detail: '原客户端对话暂时不可用，尚未发送消息' }, 5000); return 'wait'; }
    target = this.observe(this.store.get(row.destination), snapshot);
    if (target.state !== 'active') return;
    if (!['idle', 'failed'].includes(snapshot.status) && !(snapshot.status === 'paused' && snapshot.pauseKey && target.resumeKey === snapshot.pauseKey)) {
      this.store.queuedReceipt(id, { state: 'queued', detail: `原客户端对话状态：${snapshot.status}；尚未发送消息` }, 3000); return 'wait';
    }
    // Recheck route after the asynchronous native read and before reserving the write.
    if (row.source) {
      const f = this.store.db.prepare('SELECT * FROM follows WHERE source=?').get(row.source);
      if (!f?.enabled || f.destination !== row.destination || this.store.get(row.source).state === 'completed') {
        this.store.queuedReceipt(id, { state: 'cancelled' }); return;
      }
    }
    if (!this.store.claim(id)) return;
    try {
      const result = await this.transmit(target, row.body, id);
      // These native results prove no write was admitted. Unknown/held/refused never replay.
      if (['busy', 'unavailable', 'pending'].includes(result.state)) this.store.receipt(id, { ...result, state: 'queued' }, 5000);
      else this.store.receipt(id, result);
    } catch { this.store.receipt(id, { state: 'unknown', detail: '原客户端写入结果不确定，请检查原对话，不会重发' }); }
  }
  async poll() {
    // The poll lease keeps this to one process, and event ids are deterministic, so claimUntil only marks a failure backoff.
    for (const f of this.store.db.prepare('SELECT * FROM follows WHERE enabled=1 AND claimUntil<?').all(Date.now())) {
      try {
        const source = this.store.get(f.source);
        if (source.state === 'completed') continue;
        const snapshot = await this.read(source, f.cursor);
        const route = this.store.db.prepare('SELECT * FROM follows WHERE source=?').get(f.source);
        if (!route?.enabled || route.destination !== f.destination || route.seen !== f.seen) continue;
        let seen = f.seen, cursor = f.cursor;
        if (!snapshot.unchanged) {
          this.observe(this.store.get(f.source), snapshot);
          const old = new Set(JSON.parse(f.seen));
          for (const m of snapshot.messages || []) {
            if (!eligible(m) || old.has(eventKey(m)) || m.text.startsWith('[Agent talk ')) continue;
            this.enqueueEvent(f.source, f.destination, eventKey(m), `${m.role === 'user' ? '用户介入' : m.event ? '运行事件' : '最终回复'}:\n${m.text}`);
          }
          seen = JSON.stringify((snapshot.messages || []).filter(eligible).map(eventKey)); cursor = snapshot.cursor ?? null;
        }
        // An idle route writes nothing, so it costs only the shared session/list call.
        if (seen !== f.seen || cursor !== f.cursor || f.failures || f.error || f.claimUntil) this.store.db.prepare('UPDATE follows SET seen=?,cursor=?,error=NULL,failures=0,claimUntil=0 WHERE source=?').run(seen, cursor, f.source);
      } catch (e) {
        // Failed reads back off; a route failing several times in a row is closed instead of retried forever.
        // DSH being down or logged out is not the route's fault, so it only backs off.
        const failures = e.transient ? f.failures : f.failures + 1;
        if (failures >= MAX_FAILURES) this.store.db.prepare('UPDATE follows SET enabled=0,failures=?,error=? WHERE source=?').run(failures, `连续失败 ${failures} 次，已自动关闭回传：${e.message}`, f.source);
        else this.store.db.prepare('UPDATE follows SET error=?,failures=?,claimUntil=? WHERE source=?').run(e.message, failures, Date.now() + RETRY_MS, f.source);
      }
    }
    // A destination that is busy for one queued message is busy for the rest of this round too.
    const waiting = new Set();
    for (const row of this.store.db.prepare("SELECT id,destination FROM deliveries WHERE state='queued' AND nextAt<=? ORDER BY createdAt LIMIT 20").all(Date.now())) {
      if (!waiting.has(row.destination) && await this.deliver(row.id) === 'wait') waiting.add(row.destination);
    }
    // Uncertain writes are only checked for a day; after that they stay as-is and are never resent.
    // This only upgrades a receipt to observed, so it runs every 30s and reads each destination once.
    if (Date.now() < this.recheckAt) return;
    this.recheckAt = Date.now() + RECHECK_MS;
    const histories = new Map();
    for (const row of this.store.db.prepare("SELECT * FROM deliveries WHERE state IN ('unknown','sending','held') AND createdAt>? ORDER BY createdAt DESC LIMIT 20").all(Date.now() - GIVE_UP_MS)) {
      try {
        const target = this.store.get(row.destination);
        if (target.app !== 'claude') continue;
        // Unavailable history is not evidence that delivery failed.
        if (!histories.has(row.destination)) histories.set(row.destination, this.read(target).catch(() => null));
        const snapshot = await histories.get(row.destination);
        if (snapshot?.messages.some(m => m.role === 'user' && (m.text === row.body || m.text.startsWith(`Another Claude session sent a message:\n${row.body}\n\nThis came from another Claude session`)))) this.store.receipt(row.id, { state: 'observed', detail: '已在接收方原始对话记录中找到完全一致的消息，未重发' });
      } catch { /* Unknown alias: leave the receipt as-is. */ }
    }
  }
}
