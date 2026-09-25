import { openDshSocket } from './dsh-auth.mjs';
import { randomUUID } from 'node:crypto';
import { eventId } from './delivery.mjs';
import { dshCall } from './adapters.mjs';

export class DshEvents {
  constructor(store, delivery) { this.store = store; this.delivery = delivery; this.owner = randomUUID(); this.ws = null; this.clientId = null; this.error = null; this.closed = false; this.connecting = null; this.pending = new Set(); }
  tick() {
    if (this.closed || !this.store.db.prepare("SELECT 1 FROM follows f JOIN sessions s ON s.alias=f.source WHERE f.enabled=1 AND s.app='dsh' AND s.state!='completed' LIMIT 1").get()) { this.disconnect(); return; }
    if (!this.store.lease('dsh-events', this.owner)) { this.disconnect(); return; }
    if (this.ws || this.connecting) return;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
  }
  async connect() {
    try {
      const ws = await openDshSocket();
      if (this.closed || !this.store.lease('dsh-events', this.owner) || !this.store.db.prepare('SELECT 1 FROM follows WHERE enabled=1 LIMIT 1').get()) { ws.close(); return; }
      this.ws = ws;
      const timer = setTimeout(() => { if (!this.clientId) { this.error = 'DSH 事件连接握手超时'; this.disconnect(); } }, 10000);
      ws.onmessage = e => {
        if (this.closed || this.ws !== ws) return;
        const task = Promise.resolve().then(() => this.receive(JSON.parse(e.data))).catch(() => { this.error = 'DSH 事件处理失败'; });
        this.pending.add(task); task.finally(() => this.pending.delete(task));
      };
      ws.onerror = () => { this.error = 'DSH 事件连接不可用'; };
      ws.onclose = () => { clearTimeout(timer); if (this.ws === ws) { this.ws = null; this.clientId = null; } };
      ws.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }));
    } catch { this.error = 'DSH 认证不可用'; this.ws = null; }
  }
  async receive(frame) {
    if (frame.type === 'error') { this.error = `DSH 事件流错误：${frame.error?.code}`; this.disconnect(); return; }
    const event = frame.value;
    if (event?.type === 'ready') { this.clientId = event.clientId; this.error = null; return; }
    if (event?.type === 'cancel') { this.store.db.prepare("UPDATE questions SET state='closed' WHERE id=?").run(event.eventId); this.cancelNotice(event.eventId); return; }
    if (event?.type !== 'waterfall') return;
    const clientId = this.clientId;
    const source = this.store.db.prepare("SELECT s.alias,f.destination FROM sessions s JOIN follows f ON f.source=s.alias WHERE s.app='dsh' AND s.sessionId=? AND s.state!='completed' AND f.enabled=1").get(event.agentId);
    if (!source || !['user-questions/request', 'approval/request'].includes(event.event)) {
      await this.result(clientId, event.eventId, { kind: 'next' }); return;
    }
    const kind = event.event === 'approval/request' ? 'approval' : 'question';
    this.store.db.prepare("INSERT INTO questions VALUES(?,?,?,?,?,'pending',NULL) ON CONFLICT(id) DO UPDATE SET clientId=excluded.clientId WHERE questions.state='pending'").run(event.eventId, source.alias, clientId, kind, JSON.stringify(event.request));
    this.delivery.enqueueEvent(source.alias, source.destination, `question:${event.eventId}`,
      kind === 'approval' ? 'DSH 需要权限审批。请告知用户到 DSH Web 中处理，桥接服务不能代为批准。' : `DSH 正在等待回答。请用 talk_questions 读取 ${source.alias} 的问题，再用 talk_answer 回答，questionId 为 ${event.eventId}。如果需要用户决定，请向用户提问。\n${JSON.stringify(event.request.questions)}`);
    // Ordinary questions may be answered by the designated conversation. Permissions remain with the native UI.
    if (kind === 'approval') await this.result(clientId, event.eventId, { kind: 'next' });
  }
  cancelNotice(id) {
    const q = this.store.db.prepare('SELECT source FROM questions WHERE id=?').get(id);
    if (!q) return;
    for (const d of this.store.db.prepare("SELECT id,destination FROM deliveries WHERE source=? AND state='queued'").all(q.source)) {
      if (d.id === eventId(q.source, d.destination, `question:${id}`)) this.store.queuedReceipt(d.id, { state: 'cancelled', detail: '此问题已回答或关闭' });
    }
  }
  async result(clientId, eventId, outcome) { return dshCall('$events/result', {}, { clientId, eventId, outcome }); }
  async answer(source, id, answers) {
    const row = this.store.db.prepare('SELECT * FROM questions WHERE id=? AND source=?').get(id, source);
    if (!row || row.kind !== 'question') throw Error('未找到匹配的普通问题；权限审批不能在此代答');
    if (this.store.get(source).state !== 'active') throw Error('来源对话已暂停或完成');
    const request = JSON.parse(row.request);
    const questions = request.questions || [];
    if (answers.length !== questions.length || new Set(answers.map(a => a.id)).size !== answers.length) throw Error('请完整回答每个问题，且每个问题只提交一份答案');
    for (const a of answers) {
      const q = questions.find(q => q.id === a.id);
      if (!q || !Array.isArray(a.selected) || (!a.selected.length && !a.custom?.trim()) || (!q.multiSelect && a.selected.length > 1) || a.selected.some(label => !q.options?.some(o => o.label === label))) throw Error('答案与问题选项不匹配');
    }
    const serialized = JSON.stringify({ answers });
    if (row.answer) { if (row.answer !== serialized) throw Error('此前已提交不同的答案'); return { state: row.state, duplicate: true }; }
    if (row.state !== 'pending') throw Error('此问题已关闭');
    if (!this.store.db.prepare("UPDATE questions SET answer=?,state='submitting' WHERE id=? AND state='pending' AND answer IS NULL").run(serialized, id).changes) throw Error('此问题已有答案正在提交');
    try {
      await this.result(row.clientId, id, { kind: 'result', value: { answers } });
      this.cancelNotice(id);
      this.store.db.prepare("UPDATE questions SET state='submitted' WHERE id=? AND state='submitting'").run(id);
      return { state: 'submitted', detail: 'DSH 已接受回答请求，请检查恢复后的对话以确认任务是否完成' };
    } catch { this.store.db.prepare("UPDATE questions SET state='unknown' WHERE id=? AND state='submitting'").run(id); throw Error('回答提交结果不确定；尝试其他答案前请先检查 DSH'); }
  }
  disconnect() { this.ws?.close(); this.ws = null; this.clientId = null; }
  async close() { this.closed = true; this.disconnect(); await this.connecting; await Promise.allSettled([...this.pending]); this.store.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run('dsh-events', this.owner); }
}
