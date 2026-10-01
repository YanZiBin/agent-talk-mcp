import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA journal_size_limit=1048576;
      CREATE TABLE IF NOT EXISTS sessions(alias TEXT PRIMARY KEY, app TEXT NOT NULL, sessionId TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', resumeKey TEXT, UNIQUE(app,sessionId));
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, destination TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS follows(source TEXT PRIMARY KEY, destination TEXT NOT NULL, seen TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, claimUntil INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, source TEXT NOT NULL, clientId TEXT NOT NULL, kind TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL, answer TEXT);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expiresAt INTEGER NOT NULL);
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const cols = new Set(this.db.prepare('PRAGMA table_info(deliveries)').all().map(c => c.name));
    for (const [name, type] of [['state', "TEXT NOT NULL DEFAULT 'unknown'"], ['source', 'TEXT'], ['nextAt', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${type}`);
    }
    if (!cols.has('state')) this.db.exec("UPDATE deliveries SET state=COALESCE(json_extract(result,'$.state'),'unknown')");
    const followCols = new Set(this.db.prepare('PRAGMA table_info(follows)').all().map(c => c.name));
    if (!followCols.has('failures')) this.db.exec('ALTER TABLE follows ADD COLUMN failures INTEGER NOT NULL DEFAULT 0');
    if (!followCols.has('cursor')) this.db.exec('ALTER TABLE follows ADD COLUMN cursor INTEGER');
    // Receipts older than 90 days are no longer worth keeping; queued ones still have work to do.
    this.db.prepare("DELETE FROM deliveries WHERE createdAt<? AND state!='queued'").run(Date.now() - 90 * 86400000);
    this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); this.db.close(); throw e; }
  }
  get(alias) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE alias=?').get(alias);
    if (!row) throw Error('未知的对话别名'); return row;
  }
  bind(alias, app, sessionId, cwd, resumeKey = null) {
    const old = this.db.prepare('SELECT * FROM sessions WHERE alias=?').get(alias);
    if (old) { if (old.app !== app || old.sessionId !== sessionId || old.cwd !== cwd) throw Error('此别名已绑定其他对话'); return old; }
    this.db.prepare('INSERT INTO sessions(alias,app,sessionId,cwd,resumeKey) VALUES(?,?,?,?,?)').run(alias, app, sessionId, cwd, resumeKey);
    return this.get(alias);
  }
  control(alias, state, resumeKey = null) {
    const old = this.get(alias);
    if (old.state === 'completed' && state !== 'completed') throw Error('已完成的执行对话不能复用，请绑定新对话');
    this.db.prepare('UPDATE sessions SET state=?,resumeKey=? WHERE alias=?').run(state, resumeKey, alias);
    if (state === 'completed') {
      this.db.prepare('UPDATE follows SET enabled=0 WHERE source=? OR destination=?').run(alias, alias);
      this.db.prepare("UPDATE deliveries SET state='cancelled' WHERE state='queued' AND (source=? OR destination=?)").run(alias, alias);
    } else if (state === 'paused' && old.app === 'dsh') {
      // A correction after Stop must not release an old queued execution prompt.
      this.db.prepare("UPDATE deliveries SET state='cancelled' WHERE state='queued' AND destination=?").run(alias);
    }
    return this.get(alias);
  }
  reserve(id, destination, body, source = null) {
    const fingerprint = createHash('sha256').update(JSON.stringify([destination, body])).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.delivery(id);
      if (old) {
        if (old.fingerprint !== fingerprint || old.source !== source) throw Error('此请求 ID 已绑定不同内容');
        this.db.exec('COMMIT'); return { duplicate: true, result: this.result(old) };
      }
      const target = this.get(destination);
      if (target.state === 'completed' || (!source && target.state !== 'active')) throw Error('此对话的投递已暂停或完成');
      this.db.prepare("INSERT INTO deliveries(id,destination,fingerprint,body,createdAt,state,source) VALUES(?,?,?,?,?,'queued',?)").run(id, destination, fingerprint, body, Date.now(), source);
      this.db.exec('COMMIT'); return { duplicate: false };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  delivery(id) { return this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id); }
  result(row) { return { ...(row.result ? JSON.parse(row.result) : {}), state: row.state, requestId: row.id }; }
  receipt(id, result, delay = 0) {
    this.db.prepare('UPDATE deliveries SET state=?,result=?,nextAt=? WHERE id=?').run(result.state, JSON.stringify(result), Date.now() + delay, id);
    return result;
  }
  queuedReceipt(id, result, delay = 0) {
    this.db.prepare("UPDATE deliveries SET state=?,result=?,nextAt=? WHERE id=? AND state='queued'").run(result.state, JSON.stringify(result), Date.now() + delay, id);
  }
  claim(id) { return !!this.db.prepare("UPDATE deliveries SET state='sending' WHERE id=? AND state='queued' AND EXISTS (SELECT 1 FROM sessions WHERE alias=deliveries.destination AND state='active')").run(id).changes; }
  follow(source, destination, seen, cursor = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const edges = new Map(this.db.prepare('SELECT source,destination FROM follows WHERE enabled=1').all().map(r => [r.source, r.destination]));
      edges.set(source, destination);
      const visited = new Set(); let next = source;
      while (edges.has(next)) {
        if (visited.has(next)) throw Error('此自动回传设置会形成消息循环');
        visited.add(next); next = edges.get(next);
      }
      this.db.prepare('INSERT INTO follows(source,destination,seen,cursor,enabled) VALUES(?,?,?,?,1) ON CONFLICT(source) DO UPDATE SET destination=excluded.destination,seen=excluded.seen,cursor=excluded.cursor,enabled=1,failures=0,error=NULL,claimUntil=0').run(source, destination, seen, cursor);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  lease(name, owner, ttl = 60000) {
    // Every process asks every tick; only write (and fsync) when the lease is free or past half its TTL.
    const held = this.db.prepare('SELECT owner,expiresAt FROM leases WHERE name=?').get(name), now = Date.now();
    if (held && held.expiresAt - now > (held.owner === owner ? ttl / 2 : 0)) return held.owner === owner;
    this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt WHERE leases.owner=excluded.owner OR leases.expiresAt<?').run(name, owner, Date.now() + ttl, Date.now());
    return this.db.prepare('SELECT owner FROM leases WHERE name=?').get(name).owner === owner;
  }
  close() { this.db.close(); }
}
