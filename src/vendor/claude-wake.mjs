// Adapted from WebisityStudio/claude-codex-mcp-bridge (MIT), see THIRD_PARTY.md.
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privatePath } from "./local-ipc.mjs";
import { wakeNotice } from "./notice.mjs";
const execute = promisify(execFile);
const sessionRoot = ()=>join(homedir(), ".claude", "sessions");
async function boundedJson(path, max = 16_384, publicMetadata = false) {
    if (publicMetadata) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw new Error("对话注册信息的权限或类型不安全");
    } else await privatePath(path, "file");
    if ((await lstat(path)).size > max) throw new Error("进程间通信元数据过大");
    return JSON.parse(await readFile(path, "utf8"));
}
// One ps call checks every session, instead of one child process per session.
async function liveOwners(list) {
    const live = new Set();
    const candidates = list.filter((s)=>Number.isSafeInteger(s.pid) && s.pid > 0);
    if (process.platform !== "darwin" || !candidates.length) return live;
    let stdout;
    try {
        ({ stdout } = await execute("/bin/ps", [
            "-p",
            candidates.map((s)=>s.pid).join(","),
            "-o",
            "pid=",
            "-o",
            "uid=",
            "-o",
            "lstart="
        ], {
            timeout: 2000,
            env: {
                ...process.env,
                TZ: "UTC",
                LC_ALL: "C"
            }
        }));
    } catch (e) {
        // ps may exit non-zero when some listed pids are gone; the rows it did print are still valid.
        stdout = e.killed ? "" : e.stdout || "";
    }
    for (const line of stdout.split("\n")){
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match || Number(match[2]) !== process.getuid?.()) continue;
        for (const s of candidates)if (s.pid === Number(match[1]) && match[3].replace(/\s+/g, " ") === s.procStart.replace(/\s+/g, " ")) live.add(s);
    }
    return live;
}
const liveOwner = async (s)=>(await liveOwners([
        s
    ])).has(s);
export async function claudeSessions(root = sessionRoot()) {
    if (process.platform !== "darwin") return [];
    let files;
    try {
        files = await readdir(root);
    } catch  {
        return [];
    }
    const sessions = [];
    for (const file of files.filter((name)=>/^\d+\.json$/.test(name))){
        try {
            const raw = await boundedJson(join(root, file), 16_384, true);
            if (String(raw.pid) + ".json" !== file || typeof raw.sessionId !== "string" || typeof raw.procStart !== "string" || typeof raw.messagingSocketPath !== "string") continue;
            const allowedDirs = [
                "/tmp/cc-socks",
                "/private/tmp/cc-socks",
                "/tmp/cc-socks-" + process.getuid?.(),
                "/private/tmp/cc-socks-" + process.getuid?.()
            ];
            if (!allowedDirs.includes(dirname(raw.messagingSocketPath)) || !new RegExp("^" + raw.pid + "(?:-[0-9a-f]{8})?\\.sock$").test(raw.messagingSocketPath.split("/").pop())) continue;
            const session = {
                pid: raw.pid,
                sessionId: raw.sessionId,
                bridgeSessionId: raw.bridgeSessionId,
                cwd: raw.cwd,
                name: raw.name,
                messagingSocketPath: raw.messagingSocketPath,
                procStart: raw.procStart,
                version: raw.version,
                peerProtocol: raw.peerProtocol
            };
            await privatePath(session.messagingSocketPath, "socket");
            sessions.push(session);
        } catch  {}
    }
    const live = await liveOwners(sessions);
    return sessions.filter((s)=>live.has(s));
}
export class ClaudeWake {
    onLateReceipt;
    server = null;
    sockets = new Set();
    path = null;
    pending = new Map();
    constructor(onLateReceipt = ()=>{}){
        this.onLateReceipt = onLateReceipt;
    }
    async listen(directory) {
        if (this.path) return this.path;
        await mkdir(directory, {
            recursive: true,
            mode: 0o700
        });
        await privatePath(directory, "directory");
        const path = join(directory, process.pid + "-" + randomBytes(4).toString("hex") + ".sock");
        const server = createServer((socket)=>{
            this.sockets.add(socket);
            socket.on("close", ()=>this.sockets.delete(socket));
            socket.on("error", ()=>{});
            socket.setTimeout(2000, ()=>socket.destroy());
            let buffer = "";
            socket.on("data", (data)=>{
                buffer += data.toString();
                if (buffer.length > 16_384) {
                    socket.destroy();
                    return;
                }
                let newline;
                while((newline = buffer.indexOf("\n")) >= 0){
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    try {
                        const receipt = JSON.parse(line);
                        if (receipt.type !== "control" || receipt.action !== "peer_message_status") continue;
                        const p = this.pending.get(receipt.orig_msg_id);
                        if (!p) continue;
                        let result;
                        if (receipt.status === "delivered") result = {
                            state: "accepted",
                            detail: "Claude 已确认收到对话间消息"
                        };
                        else if (receipt.status === "held") result = {
                            state: "held",
                            detail: "Claude 返回 held：已暂存此对话间消息，尚未交给模型处理。此回执未说明具体原因，请检查原客户端；不要重发。"
                        };
                        else if ([
                            "denied",
                            "refused",
                            "dropped",
                            "expired"
                        ].includes(receipt.status)) result = {
                            state: "refused",
                            detail: "Claude 未接收此对话间消息，原始状态：" + receipt.status
                        };
                        else continue;
                        clearTimeout(p.timer);
                        p.settle(result);
                        this.onLateReceipt(p.job, result);
                        if (receipt.status !== "held") this.pending.delete(receipt.orig_msg_id);
                    } catch  {}
                }
            });
        });
        await new Promise((ok, fail)=>{
            server.once("error", fail);
            server.listen(path, ok);
        });
        await chmod(path, 0o600);
        this.server = server;
        this.path = path;
        return path;
    }
    async wake(job, root = sessionRoot()) {
        if (process.platform !== "darwin") return {
            state: "refused",
            detail: "Claude 桌面对话唤醒适配器目前仅支持 macOS"
        };
        let written = false;
        try {
            const matches = (await claudeSessions(root)).filter((s)=>s.sessionId === job.target.sessionId || s.bridgeSessionId === job.target.sessionId);
            if (matches.length !== 1) return {
                state: "pending",
                detail: "无法为此 Claude 对话确定唯一且正在运行的本地消息接收端"
            };
            const session = matches[0];
            if (session.peerProtocol !== 1) return {
                state: "refused",
                detail: "不支持此 Claude 对话间通信协议"
            };
            const hash = createHash("sha256").update(resolve(session.messagingSocketPath)).digest("hex");
            const key = await boundedJson(join(root, session.pid + "." + hash + ".key"), 4096);
            if (typeof key.peerToken !== "string" || !/^[0-9a-f]{32}$/.test(key.peerToken) || key.procStart !== session.procStart) return {
                state: "refused",
                detail: "Claude 消息接收端的认证信息与其进程不匹配"
            };
            const callback = await this.listen(dirname(session.messagingSocketPath));
            if (!await liveOwner(session)) return {
                state: "pending",
                detail: "投递前 Claude 进程已停止"
            };
            for (const [oldId, p] of this.pending){
                if (Date.now() - p.job.createdAt > 3_600_000 || this.pending.size >= 100) {
                    clearTimeout(p.timer);
                    this.pending.delete(oldId);
                }
            }
            const id = job.attemptId;
            const result = new Promise((settle)=>{
                const timer = setTimeout(()=>{
                    settle({
                        state: "unknown",
                        detail: "消息已提交，正在等待 Claude 回执。不会自动重发。"
                    });
                }, 1800);
                this.pending.set(id, {
                    job,
                    settle,
                    timer
                });
            });
            await new Promise((ok, fail)=>{
                const socket = createConnection(session.messagingSocketPath);
                socket.setTimeout(2000, ()=>{
                    socket.destroy();
                    fail(new Error("进程间通信超时"));
                });
                socket.once("error", fail);
                socket.once("connect", ()=>{
                    written = true;
                    socket.end(JSON.stringify({
                        type: "auth",
                        token: key.peerToken
                    }) + "\n" + JSON.stringify({
                        type: "user",
                        msgV: 1,
                        msg_id: id,
                        session_id: session.sessionId,
                        from: "uds:" + callback,
                        priority: "next",
                        message: {
                            role: "user",
                            content: wakeNotice(job)
                        }
                    }) + "\n", ok);
                });
            });
            return await result;
        } catch  {
            if (!written && job.attemptId) {
                const p = this.pending.get(job.attemptId);
                if (p) {
                    clearTimeout(p.timer);
                    this.pending.delete(job.attemptId);
                }
            }
            return written ? {
                state: "unknown",
                detail: "无法确认 Claude 投递结果，不会自动重发"
            } : {
                state: "pending",
                detail: "Claude 本地消息接收端不可用，或未通过所有权检查"
            };
        }
    }
    async close() {
        for (const p of this.pending.values()){
            clearTimeout(p.timer);
            p.settle({
                state: "unknown",
                detail: "尚未收到 Claude 回执，桥接服务已停止"
            });
        }
        this.pending.clear();
        for (const socket of this.sockets)socket.destroy();
        if (this.server) await new Promise((ok)=>this.server.close(()=>ok()));
        if (this.path) await unlink(this.path).catch(()=>{});
        this.server = null;
        this.path = null;
    }
}
