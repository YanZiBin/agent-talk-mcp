// Adapted from WebisityStudio/claude-codex-mcp-bridge (MIT), see THIRD_PARTY.md.
import { dirname, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
export async function privatePath(path, kind) {
    const stat = await lstat(path);
    const matches = kind === "socket" ? stat.isSocket() : kind === "file" ? stat.isFile() : stat.isDirectory();
    if (!matches || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error("本地进程间通信路径的所有者、类型或权限不符合要求");
    }
}

// The Desktop pipe authenticates its signed bundled Node runtime, not arbitrary system Node.
export async function desktopTool({ pipe, threadId, tool, args }) {
    if (!['list_projects','create_thread'].includes(tool)) throw Error('不支持此桌面操作');
    await privatePath(pipe, "socket");
    const id = randomUUID(), payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
        namespace: "codex_app", callerSource: "codex", threadId, turnId: `agent-talk-${id}`, callId: `agent-talk-${id}`, tool, arguments: args,
    } }));
    if (payload.length > 128 * 1024) throw Error("桌面请求过大");
    return new Promise((resolve, reject) => {
        const socket = createConnection(pipe); let buffer = Buffer.alloc(0), sent = false, settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(Object.assign(error, { uncertain: sent })) : resolve(value); };
        const timer = setTimeout(() => finish(Error("Codex 桌面请求超时；已提交的请求不能重发")), 30000);
        socket.on("error", e => finish(e));
        socket.on("close", () => finish(Error("Codex 桌面接口断开；请检查原请求")));
        socket.on("connect", () => { const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); sent = true; socket.write(Buffer.concat([header, payload])); });
        socket.on("data", chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > 8 * 1024 * 1024) return finish(Error("桌面回执过大"));
            while (buffer.length >= 4) {
                const size = buffer.readUInt32LE(0); if (!size || size > 8 * 1024 * 1024) return finish(Error("桌面回执格式无效"));
                if (buffer.length < size + 4) return;
                let response; try { response = JSON.parse(buffer.subarray(4, size + 4)); } catch { return finish(Error("桌面回执无法解析")); }
                buffer = buffer.subarray(size + 4); if (response.id !== id) continue;
                if (response.error) return finish(Error(response.error.message));
                const result = response.result, content = result?.contentItems ?? result?.content ?? [];
                const text = content.filter(p => typeof p.text === "string").map(p => p.text).join("\n");
                if (!result?.success || result.isError) return finish(Error(text || "Codex 桌面未确认请求"));
                try { finish(null, result.structuredContent ?? JSON.parse(text)); } catch { finish(Error("Codex 桌面回执缺少结构化结果")); }
            }
        });
    });
}

export async function desktopRelay(pipe, request) {
    await privatePath(pipe, "socket");
    return new Promise((resolve, reject) => {
        const socket = createConnection(pipe); let data = "", settled = false;
        const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
        const timer = setTimeout(() => finish(Error("Codex 本机转接超时；不要重发原请求")),35000);
        socket.on("error", e => finish(e)); socket.on("close", () => finish(Error("Codex 本机转接断开；请检查原请求")));
        socket.on("connect", () => socket.write(JSON.stringify(request)+"\n"));
        socket.on("data", chunk => { data += chunk; if (data.length > 8 * 1024 * 1024) return finish(Error("转接回执过大")); if (!data.includes("\n")) return; try { const r = JSON.parse(data.slice(0,data.indexOf("\n"))); r.error ? finish(Error(r.error)) : finish(null,r.value); } catch { finish(Error("转接回执无效")); } });
    });
}

export async function serveDesktopRelay(pipe, call) {
    if (fs.existsSync(pipe)) { await privatePath(pipe,"socket"); fs.unlinkSync(pipe); }
    const sockets = new Set();
    const server = createServer(socket => {
        sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); socket.on("error",()=>{}); socket.setTimeout(35000,()=>socket.destroy());
        let data = "", submitted = false;
        socket.on("data", async chunk => {
            if (submitted) return; data += chunk; if (Buffer.byteLength(data)>128*1024) return socket.destroy(); if (!data.includes("\n")) return;
            submitted = true;
            try {
                const r = JSON.parse(data.slice(0,data.indexOf("\n")));
                if (!['list_projects','create_thread'].includes(r.tool) || typeof r.threadId !== 'string' || !r.args || typeof r.args !== 'object') throw Error("不支持此桌面转接请求");
                socket.end(JSON.stringify({value:await call(r)})+"\n");
            } catch(e) { socket.end(JSON.stringify({error:e.message})+"\n"); }
        });
    });
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(pipe,resolve)}); fs.chmodSync(pipe,0o600);
    const inode = fs.statSync(pipe).ino;
    return async () => { for (const s of sockets)s.destroy(); await new Promise(r=>server.close(r)); try { if(fs.statSync(pipe).ino===inode)fs.unlinkSync(pipe); } catch {} };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let input = ""; for await (const chunk of process.stdin) { input += chunk; if (input.length > 160000) throw Error("桌面请求过大"); }
    try {
        const request = JSON.parse(input);
        const value = process.env.CODEX_APP_TOOLS_PIPE_PATH ? await desktopTool(request)
            : await desktopRelay(resolve(dirname(fileURLToPath(import.meta.url)), "../../.local/codex-desktop-relay.sock"), { threadId: request.threadId, tool: request.tool, args: request.args });
        process.stdout.write(JSON.stringify({ value }));
    }
    catch (e) { process.stdout.write(JSON.stringify({ error: e.message, uncertain: !!e.uncertain })); process.exitCode = 1; }
}
export class IpcError extends Error {
    sent;
    constructor(message, sent = false){
        super(message), this.sent = sent;
    }
}
export class CodexIpc {
    socket = null;
    buffer = Buffer.alloc(0);
    clientId = "initializing-client";
    pending = new Map();
    async connect(path) {
        await privatePath(dirname(path), "directory");
        await privatePath(path, "socket");
        await new Promise((resolve, reject)=>{
            const socket = this.socket = createConnection(path);
            const timer = setTimeout(()=>{
                socket.destroy();
                reject(new IpcError("Codex 连接超时"));
            }, 3000);
            socket.once("connect", ()=>{
                clearTimeout(timer);
                resolve();
            });
            socket.on("error", ()=>{
                clearTimeout(timer);
                reject(new IpcError("Codex 连接不可用"));
                this.fail();
            });
            socket.on("close", ()=>this.fail());
            socket.on("data", (chunk)=>{
                try {
                    this.read(chunk);
                } catch  {
                    socket.destroy();
                    this.fail();
                }
            });
        });
        const reply = await this.request("initialize", {
            clientType: "claude-codex-bridge"
        });
        if (reply.resultType !== "success" || typeof reply.result?.clientId !== "string") {
            throw new IpcError("Codex 拒绝进程间通信初始化");
        }
        this.clientId = reply.result.clientId;
    }
    fail() {
        for (const p of this.pending.values()){
            clearTimeout(p.timer);
            p.reject(new IpcError("无法取得 Codex 进程间通信响应", true));
        }
        this.pending.clear();
    }
    write(packet) {
        const body = Buffer.from(JSON.stringify(packet));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        this.socket.write(Buffer.concat([
            header,
            body
        ]));
    }
    read(chunk) {
        this.buffer = Buffer.concat([
            this.buffer,
            chunk
        ]);
        while(this.buffer.length >= 4){
            const length = this.buffer.readUInt32LE(0);
            if (length > 8 * 1024 * 1024) throw new Error("进程间通信数据帧过大");
            if (this.buffer.length < length + 4) return;
            const p = JSON.parse(this.buffer.subarray(4, length + 4).toString());
            this.buffer = this.buffer.subarray(length + 4);
            if (p.type === "client-discovery-request") {
                this.write({
                    type: "client-discovery-response",
                    requestId: p.requestId,
                    response: {
                        canHandle: false
                    }
                });
            } else if (p.type === "response") {
                const waiting = this.pending.get(p.requestId);
                if (!waiting) continue;
                this.pending.delete(p.requestId);
                clearTimeout(waiting.timer);
                waiting.resolve(p);
            }
        }
    }
    request(method, params, version = 0, targetClientId) {
        if (!this.socket || this.socket.destroyed) return Promise.reject(new IpcError("Codex 已断开连接"));
        return new Promise((resolve, reject)=>{
            const requestId = randomUUID();
            const timer = setTimeout(()=>{
                this.pending.delete(requestId);
                reject(new IpcError("Codex 进程间通信响应超时", true));
            }, 10_000);
            this.pending.set(requestId, {
                resolve,
                reject,
                timer
            });
            this.write({
                type: "request",
                requestId,
                sourceClientId: this.clientId,
                version,
                method,
                params,
                ...targetClientId ? {
                    targetClientId
                } : {}
            });
        });
    }
    close() {
        this.socket?.destroy();
        this.fail();
    }
}
