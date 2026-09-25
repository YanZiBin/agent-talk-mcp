// Adapted from WebisityStudio/claude-codex-mcp-bridge (MIT), see THIRD_PARTY.md.
import { dirname } from "node:path";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
export async function privatePath(path, kind) {
    const stat = await lstat(path);
    const matches = kind === "socket" ? stat.isSocket() : kind === "file" ? stat.isFile() : stat.isDirectory();
    if (!matches || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error("本地进程间通信路径的所有者、类型或权限不符合要求");
    }
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
