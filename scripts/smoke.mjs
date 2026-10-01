import http from 'node:http';
import { once } from 'node:events';
import { ensureDshAuth, readPrivate, writePrivate, cookieExpiry } from '../src/dsh-auth.mjs';
import { dshCall } from '../src/adapters.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textParts, resolveDshLocation } from '../src/adapters.mjs';
import { Store } from '../src/store.mjs';
import { Delivery } from '../src/delivery.mjs';
import { DshEvents } from '../src/dsh-events.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-talk-smoke-'));
try {
  assert.equal(textParts([{type:'reasoning',text:'internal'}, {type:'text',text:'visible reply'}, {type:'tool_use',text:'not a reply'}]), 'visible reply');
  assert.equal(textParts([{type:'input_text',text:'user'}, {type:'output_text',text:'assistant'}]), 'user\nassistant');
  const cwd = fs.realpathSync(dir), otherDir = path.join(cwd, 'other'); fs.mkdirSync(otherDir);
  const workspaces = [{ workspaceId: 'w1', title: 'Project', path: cwd, sessionIds: [] }];
  assert.equal(resolveDshLocation(undefined, 'Project', workspaces).workspace.workspaceId, 'w1');
  assert.equal(resolveDshLocation(cwd, undefined).cwd, cwd);
  assert.equal(resolveDshLocation(cwd, 'Project', workspaces).cwd, cwd);
  assert.throws(() => resolveDshLocation(undefined, undefined), /请提供/);
  assert.throws(() => resolveDshLocation(cwd, 'Missing', workspaces), /未找到/);
  assert.throws(() => resolveDshLocation(otherDir, 'Project', workspaces), /不一致/);
  const duplicates = [...workspaces, { workspaceId: 'w2', title: 'Project', path: otherDir, sessionIds: [] }];
  assert.throws(() => resolveDshLocation(undefined, 'Project', duplicates), /同名/);
  assert.equal(resolveDshLocation(otherDir, 'Project', duplicates).workspace.workspaceId, 'w2');
  // Exercise renewal through an ordinary local HTTP login, including a rejected RPC.
  let token = 'initial', cookie, exchanges = 0, rpcAttempts = 0, admitted = 0;
  const host = http.createServer(async (req, res) => {
    if (req.url === '/?token=' + token) {
      exchanges++;
      const payload = Buffer.from(JSON.stringify({expiresAt:Date.now()+30*86400000})).toString('base64url');
      cookie = `dsh-auth-test=v1.${payload}.signature-${exchanges}`;
      res.writeHead(303, {'set-cookie':cookie+'; HttpOnly; Path=/','location':'./'}); res.end(); return;
    }
    rpcAttempts++;
    if (req.headers.cookie !== cookie) {res.writeHead(401);res.end();return;}
    admitted++;let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({type:'server-response',rpcId:request.rpcId,result:{ok:true,value:{items:[]}}}));
  });
  host.listen(0,'127.0.0.1'); await once(host,'listening');
  const previous = {auth:process.env.AGENT_TALK_DSH_AUTH,login:process.env.AGENT_TALK_DSH_LOGIN};
  process.env.AGENT_TALK_DSH_AUTH=path.join(cwd,'auth.json');process.env.AGENT_TALK_DSH_LOGIN=path.join(cwd,'login.json');
  const baseUrl=`http://127.0.0.1:${host.address().port}`;
  try {
    writePrivate(process.env.AGENT_TALK_DSH_LOGIN,{baseUrl,loginUrl:baseUrl+'/?token='+token});
    const fresh=await Promise.all([ensureDshAuth(),ensureDshAuth()]);assert.equal(exchanges,1);assert.equal(fresh[0].cookie,fresh[1].cookie);
    const saved=readPrivate(process.env.AGENT_TALK_DSH_AUTH);
    writePrivate(process.env.AGENT_TALK_DSH_AUTH,{...saved,cookie:saved.cookie+'-invalid'});
    await dshCall('session/list');assert.equal(exchanges,2);assert.equal(rpcAttempts,2);assert.equal(admitted,1);
    const expired='dsh-auth-test=v1.'+Buffer.from(JSON.stringify({expiresAt:Date.now()-1000})).toString('base64url')+'.expired';
    writePrivate(process.env.AGENT_TALK_DSH_AUTH,{...saved,cookie:expired});
    assert.ok(cookieExpiry((await ensureDshAuth()).cookie)>Date.now());assert.equal(exchanges,3);
    token='after-restart';writePrivate(process.env.AGENT_TALK_DSH_LOGIN,{baseUrl,loginUrl:baseUrl+'/?token='+token});
    await ensureDshAuth();assert.equal(exchanges,4);
    fs.chmodSync(process.env.AGENT_TALK_DSH_LOGIN,0o644);
    await assert.rejects(ensureDshAuth(),/权限为 600/);fs.chmodSync(process.env.AGENT_TALK_DSH_LOGIN,0o600);
    writePrivate(process.env.AGENT_TALK_DSH_LOGIN,{baseUrl:'http://example.com',loginUrl:'http://example.com/?token=x'});
    await assert.rejects(ensureDshAuth(),/回环/);assert.equal(exchanges,4);
  } finally {
    host.closeAllConnections();await new Promise(r=>host.close(r));
    for(const [key,value] of [['AGENT_TALK_DSH_AUTH',previous.auth],['AGENT_TALK_DSH_LOGIN',previous.login]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  const store = new Store(path.join(dir, 'state.sqlite')), peer = new Store(path.join(dir, 'state.sqlite'));
  store.bind('dsh', 'dsh', 'native-test', dir); store.bind('planner', 'claude', 'native-planner', dir);
  let status = 'running', pauseKey = null, writes = 0, outcome = 'accepted', messages = [];
  const read = async () => ({ status, pauseKey, messages });
  const transmit = async () => { writes++; return { state: outcome }; };
  const delivery = new Delivery(store, read, transmit), other = new Delivery(peer, read, transmit);
  assert.equal((await delivery.submit('dsh', 'hello', 'busy')).state, 'queued');
  assert.equal(writes, 0);
  assert.equal((await other.submit('dsh', 'hello', 'busy')).duplicate, true);
  await assert.rejects(other.submit('dsh', 'different', 'busy'), /不同内容/);
  status = 'idle';
  await Promise.all([delivery.deliver('busy'), other.deliver('busy')]);
  assert.equal(writes, 1); assert.equal(store.delivery('busy').state, 'accepted');
  store.queuedReceipt('busy', { state: 'queued' }); assert.equal(store.delivery('busy').state, 'accepted');
  outcome = 'unknown'; await delivery.submit('dsh', 'uncertain', 'unknown');
  await delivery.deliver('unknown'); assert.equal(writes, 2);
  status = 'running'; await delivery.submit('dsh', 'obsolete task', 'old');
  status = 'paused'; pauseKey = 'stop1'; await delivery.deliver('old');
  assert.equal(store.get('dsh').state, 'paused'); assert.equal(store.delivery('old').state, 'cancelled');
  await assert.rejects(delivery.submit('dsh', 'no resume', 'blocked'), /暂停/);
  store.control('dsh', 'active', pauseKey); outcome = 'accepted';
  assert.equal((await delivery.submit('dsh', 'corrected task', 'new')).state, 'accepted');
  store.follow('dsh', 'planner', '[]'); store.control('planner', 'paused');
  store.control('dsh', 'paused', pauseKey);
  messages = [{ id: 'manual', role: 'user', text: 'Changed direction' }, { id: 'final', role: 'assistant', final: true, text: 'Updated result' }];
  await delivery.poll();
  const queued = store.db.prepare("SELECT * FROM deliveries WHERE source='dsh'").all();
  assert.equal(queued.length, 2); assert.ok(queued.every(r => r.state === 'queued'));
  assert.ok(queued.some(r => r.body.includes('用户介入:\nChanged direction')));
  assert.ok(queued.some(r => r.body.includes('最终回复:\nUpdated result')));
  store.control('planner', 'active', pauseKey); status = 'idle';
  await delivery.poll(); assert.ok(store.db.prepare("SELECT * FROM deliveries WHERE source='dsh'").all().every(r => r.state === 'accepted'));
  store.control('planner', 'paused'); delivery.enqueueEvent('dsh', 'planner', 'late', 'result');
  store.control('dsh', 'completed');
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE source='dsh' ORDER BY rowid DESC LIMIT 1").get().state, 'cancelled');
  assert.throws(() => store.control('dsh', 'active'), /已完成/);
  assert.throws(() => store.bind('dsh', 'dsh', 'different', dir), /其他对话/);
  // A failing route backs off instead of retrying every tick, and closes after three failures in a row.
  store.bind('flaky', 'dsh', 'flaky-session', dir); store.follow('flaky', 'planner', '[]');
  const flaky = new Delivery(store, async () => { throw Error('DSH down'); }, transmit);
  await flaky.poll(); let route = store.db.prepare("SELECT * FROM follows WHERE source='flaky'").get();
  assert.equal(route.enabled, 1); assert.ok(route.claimUntil > Date.now()); assert.equal(route.failures, 1);
  for (const n of [2, 3]) { store.db.prepare("UPDATE follows SET claimUntil=0 WHERE source='flaky'").run(); await flaky.poll(); }
  route = store.db.prepare("SELECT * FROM follows WHERE source='flaky'").get();
  assert.equal(route.enabled, 0); assert.equal(route.failures, 3); assert.match(route.error, /连续失败 3 次/);
  // DSH itself being down only backs off; an unchanged history is not re-read and writes nothing.
  store.bind('steady', 'dsh', 'steady-session', dir); store.follow('steady', 'planner', '[]', 7);
  await new Delivery(store, async () => { throw Object.assign(Error('DSH down'), { transient: true }); }, transmit).poll();
  route = store.db.prepare("SELECT * FROM follows WHERE source='steady'").get();
  assert.equal(route.enabled, 1); assert.equal(route.failures, 0); assert.ok(route.claimUntil > Date.now());
  store.db.prepare("UPDATE follows SET claimUntil=0,error=NULL WHERE source='steady'").run();
  let since; route = store.db.prepare("SELECT * FROM follows WHERE source='steady'").get();
  await new Delivery(store, async (t, cursor) => { since = cursor; return { unchanged: true, cursor }; }, transmit).poll();
  assert.equal(since, 7); assert.deepEqual(store.db.prepare("SELECT * FROM follows WHERE source='steady'").get(), route);
  store.control('steady', 'completed');
  assert.equal(store.lease('events', 'one'), true); assert.equal(peer.lease('events', 'two'), false);
  // Permission requests cannot be converted to approvals through the ordinary answer tool.
  const events = new DshEvents(store, delivery);
  store.db.prepare("INSERT INTO questions VALUES('permission','dsh','client','approval','{}','pending',NULL)").run();
  await assert.rejects(events.answer('dsh', 'permission', []), /权限审批/);
  store.bind('questioner', 'dsh', 'asking-session', dir);
  store.control('planner', 'active', pauseKey);
  const q = {questions:[{id:'choice',question:'Choose',options:[{label:'A'},{label:'B'}]}]};
  store.db.prepare("INSERT INTO questions VALUES('question','questioner','client','question',?,'pending',NULL)").run(JSON.stringify(q));
  const notification = delivery.enqueueEvent('questioner', 'planner', 'question:question', 'waiting');
  let answersSent=0; events.result=async()=>{answersSent++};
  await assert.rejects(events.answer('questioner','question',[{id:'choice',selected:['invalid']}]), /选项/);
  await events.answer('questioner','question',[{id:'choice',selected:['A']}]);
  await events.answer('questioner','question',[{id:'choice',selected:['A']}]);
  assert.equal(answersSent,1); assert.equal(store.delivery(notification).state,'cancelled');
  await events.close(); peer.close(); store.close();

  // 隔离的 DSH 接口验证默认回传，不连接真实客户端或发送 AI 消息。
  const nativeSessions = new Map(); let creations = 0;
  const native = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body), args = rpc.payload.args.request;
    let value;
    if (rpc.method === 'session/create') {
      creations++;
      nativeSessions.set(args.sessionId, { sessionId: args.sessionId, cwd: args.cwd, running: false, projections: { asOfSeq: 0 } });
      value = { sessionId: args.sessionId };
    } else if (rpc.method === 'session/list') value = { items: [...nativeSessions.values()] };
    else if (rpc.method === 'session/page') value = { records: [], hasMore: false };
    else { res.writeHead(400); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }));
  });
  native.listen(0, '127.0.0.1'); await once(native, 'listening');
  const mcpDb = path.join(dir, 'mcp.sqlite'), mcpAuth = path.join(dir, 'mcp-auth.json');
  writePrivate(mcpAuth, { baseUrl: `http://127.0.0.1:${native.address().port}`, cookie: 'dsh-auth-test=v1.' + Buffer.from(JSON.stringify({ expiresAt: Date.now() + 86400000 })).toString('base64url') + '.test' });
  const mcpStore = new Store(mcpDb); mcpStore.bind('initiator', 'claude', 'mock-initiator', cwd);
  const client = new Client({ name: 'agent-talk-smoke', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.mjs'], env: { ...process.env, AGENT_TALK_DB: mcpDb, AGENT_TALK_DSH_AUTH: mcpAuth, AGENT_TALK_DSH_LOGIN: path.join(dir, 'no-login.json') }, stderr: 'pipe' }));
    const { tools } = await client.listTools(); assert.ok(tools.some(t => t.name === 'talk_answer')); assert.ok(tools.some(t => t.name === 'talk_workspaces'));
    assert.match(client.getInstructions(), /默认使用简体中文/);
    assert.match(client.getInstructions(), /先结合当前对话的目标和上下文理解、判断/);
    assert.ok(tools.every(t => /[\u4e00-\u9fff]/.test(t.description)));
    assert.ok(tools.find(t => t.name === 'talk_create').inputSchema.properties.workspaceName);
    assert.equal(tools.find(t => t.name === 'talk_create').inputSchema.properties.autoReturn.default, true);
    const r = await client.callTool({ name: 'talk_create', arguments: { alias: 'not-created', app: 'claude', cwd: process.cwd(), requestId: crypto.randomUUID() } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /参数校验失败/);
    const missing = await client.callTool({ name: 'talk_read', arguments: { alias: 'missing' } });
    assert.equal(missing.isError, true); assert.match(missing.content[0].text, /未知的对话别名/);
    const out = await client.callTool({ name: 'talk_outbox', arguments: {} }); assert.equal(JSON.parse(out.content[0].text).deliveries.length, 0);
    const createArgs = { alias: 'default-return', cwd, requestId: crypto.randomUUID() };
    const noTarget = await client.callTool({ name: 'talk_create', arguments: createArgs });
    assert.equal(noTarget.isError, true); assert.match(noTarget.content[0].text, /默认开启自动回传/); assert.equal(creations, 0);
    const created = await client.callTool({ name: 'talk_create', arguments: { ...createArgs, replyTo: 'initiator' } });
    assert.ok(!created.isError);
    assert.equal(JSON.parse(created.content[0].text).returnRoute.enabled, true);
    assert.equal(JSON.parse(created.content[0].text).returnRoute.destination, 'initiator');
    const again = await client.callTool({ name: 'talk_create', arguments: { ...createArgs, replyTo: 'initiator' } });
    assert.ok(!again.isError); assert.equal(creations, 1);
    mcpStore.reserve('held-test', 'initiator', 'mock result', createArgs.alias);
    mcpStore.receipt('held-test', { state: 'held', detail: '客户端暂存' });
    const readResult = await client.callTool({ name: 'talk_read', arguments: { alias: createArgs.alias } });
    assert.ok(!readResult.isError);
    const state = JSON.parse(readResult.content[0].text);
    assert.equal(state.returnRoute.enabled, true); assert.equal(state.lastReturn.state, 'held');
    const conflict = await client.callTool({ name: 'talk_create', arguments: { ...createArgs, replyTo: 'initiator', autoReturn: false } });
    assert.equal(conflict.isError, true); assert.match(conflict.content[0].text, /冲突/);
    const disabled = await client.callTool({ name: 'talk_create', arguments: { ...createArgs, autoReturn: false } });
    assert.ok(!disabled.isError); assert.equal(JSON.parse(disabled.content[0].text).returnRoute.enabled, false);
    const oneWay = await client.callTool({ name: 'talk_create', arguments: { alias: 'one-way', cwd, requestId: crypto.randomUUID(), autoReturn: false } });
    assert.ok(!oneWay.isError); assert.equal(JSON.parse(oneWay.content[0].text).returnRoute.enabled, false); assert.equal(creations, 2);
  } finally { await client.close(); mcpStore.close(); native.closeAllConnections(); await new Promise(r => native.close(r)); }
  console.log('通过：忙碌排队、并发防重、不确定结果不重发、原生停止与恢复、用户介入回传、完成状态、事件连接所有权、审批拒绝、工作区匹配、凭据续期与权限、MCP 参数及中文说明、默认回传与显式关闭、held 回执展示。未发送 AI 消息。');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
