
import HTML from "./index.html";

// Service Worker 现已停用。历史版本曾缓存应用外壳，但在频繁迭代加密/协议时会造成
// 新旧版本混用（进房慢、收不到他人消息、列表不更新）。/sw.js 改为返回"自毁脚本"：
// 浏览器后台更新 SW 时会拿到它，从而清空所有缓存并注销自身，确保所有客户端回到最新版。
const SW = `// 自毁 Service Worker：清缓存 + 注销自身
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    await self.registration.unregister();
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.navigate(c.url));
  })());
});
`;

// 每个房间最多保留的历史消息条数
const MAX_HISTORY = 200;

// 掉线宽限期（毫秒）：连接正常断开（收到 close 帧）后，此期间同名重连不算离开（刷新/短暂断网不掉房）；
// 超过该时长仍未重连则自动踢出。按需求设为 1 分钟。
const LEAVE_GRACE_MS = 60000;

// 死连接判定（毫秒）：仅用于"浏览器硬关闭/进程被杀，没发 close 帧"的兜底清扫。
// 设得较宽（5 分钟），避免把"切后台/最小化导致心跳被浏览器节流"的在线用户误判为掉线。
// 真正的断网会触发 WebSocket close 事件，由上面的 60 秒宽限处理，不依赖此值。
const CONN_STALE_MS = 300000;

// 文件存储上限（DO 内存有限，约 128MB）：单文件密文 ≤ 30MB，单房间所有文件密文合计 ≤ 90MB
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_ROOM_FILE_BYTES = 90 * 1024 * 1024;

// 错误码定义
const ERR = {
  WRONG_CODE: 1001,     // 口令错误（格式非法）
  ROOM_CLOSED: 1002,    // 房间已关闭（allowJoin = false）
  BLACKLISTED: 1003,    // 已被拉黑
  WRONG_PASSWORD: 1004, // 房间密码错误
  NAME_TAKEN: 1005,     // 昵称已被房间内活跃用户占用
};

// =============================================================================
// 工具函数区
// =============================================================================

// 生成 8 位随机字符串作为连接 ID
function genConnectionId() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// 服务端二次哈希：SHA-256(text) 的十六进制字符串
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// 校验房间口令是否为 6 位纯数字
function isValidRoomCode(code) {
  return typeof code === "string" && /^\d{6}$/.test(code);
}

// 安全发送：向某个 WebSocket 发送 JSON 对象
function sendJSON(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (err) { /* 连接已断开，忽略 */ }
}

// =============================================================================
// KV 操作区
// =============================================================================
// KV 存储结构：
//   room:{口令}:settings  -> { allowJoin, hasPassword }
//   room:{口令}:blacklist -> [ userId, ... ]
//   room:{口令}:order     -> [ userId, ... ]（房主始终在索引 0）
//   room:{口令}:meta      -> { createdAt, lastActiveAt }
//   room:{口令}:password  -> SHA-256(盐 + authHash)（无密码时该键不存在）
//   room:{口令}:salt      -> 房间盐（前端派生密钥与密码哈希都用它）
const kvKey = {
  settings: (r) => `room:${r}:settings`,
  blacklist: (r) => `room:${r}:blacklist`,
  order: (r) => `room:${r}:order`,
  meta: (r) => `room:${r}:meta`,
  password: (r) => `room:${r}:password`,
  salt: (r) => `room:${r}:salt`,
};

async function kvGetJSON(env, key, fallback = null) {
  const raw = await env.ROOM_KV.get(key);
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function kvPutJSON(env, key, value) {
  await env.ROOM_KV.put(key, JSON.stringify(value));
}
async function getRoomSettings(env, roomId) { return await kvGetJSON(env, kvKey.settings(roomId), null); }
async function getBlacklist(env, roomId) { return await kvGetJSON(env, kvKey.blacklist(roomId), []); }
async function getPassword(env, roomId) { return await env.ROOM_KV.get(kvKey.password(roomId)); }
async function getSalt(env, roomId) { return await env.ROOM_KV.get(kvKey.salt(roomId)); }
async function getOrder(env, roomId) { return await kvGetJSON(env, kvKey.order(roomId), []); }
async function setOrder(env, roomId, order) { await kvPutJSON(env, kvKey.order(roomId), order); }

async function touchRoom(env, roomId) {
  const meta = (await kvGetJSON(env, kvKey.meta(roomId), {})) || {};
  meta.lastActiveAt = Date.now();
  if (!meta.createdAt) meta.createdAt = Date.now();
  await kvPutJSON(env, kvKey.meta(roomId), meta);
}

// 创建新房间（首个用户进入时调用）
async function createRoom(env, roomId, salt, passwordHash) {
  const now = Date.now();
  const hasPassword = !!passwordHash;
  await kvPutJSON(env, kvKey.settings(roomId), { allowJoin: true, hasPassword });
  await kvPutJSON(env, kvKey.blacklist(roomId), []);
  await kvPutJSON(env, kvKey.order(roomId), []);
  await kvPutJSON(env, kvKey.meta(roomId), { createdAt: now, lastActiveAt: now });
  await env.ROOM_KV.put(kvKey.salt(roomId), salt);
  if (hasPassword) await env.ROOM_KV.put(kvKey.password(roomId), passwordHash);
}

// 房间重置：批量删除房间所有 KV 键
async function resetRoom(env, roomId) {
  await Promise.all([
    env.ROOM_KV.delete(kvKey.settings(roomId)),
    env.ROOM_KV.delete(kvKey.blacklist(roomId)),
    env.ROOM_KV.delete(kvKey.order(roomId)),
    env.ROOM_KV.delete(kvKey.meta(roomId)),
    env.ROOM_KV.delete(kvKey.password(roomId)),
    env.ROOM_KV.delete(kvKey.salt(roomId)),
  ]);
}

// 构造用户列表：[{ id, name, isOwner }]（顺序按 order，索引 0 为房主）
function buildUserList(order) {
  return order.map((uid, idx) => ({ id: uid, name: uid, isOwner: idx === 0 }));
}
// =============================================================================
// Durable Object：ChatRoom —— 单房间的连接表、广播、历史均在此实例内存中
// =============================================================================
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // connectionId -> { ws, roomId, userId }
    this.connections = new Map();
    // 内存历史消息（密文，服务器无法解密）
    this.history = [];
    // userId -> 离开宽限计时器（用于区分"刷新/短暂断线"与"真正离开"）
    this.leaveTimers = new Map();
    // 文件存储：fileId -> { meta:{fileId,name,size,chunks}, parts:[密文,...], done }
    // 文件密文存于 DO 内存，服务器不持密钥无法解密；房间清空时一并释放
    this.files = new Map();
    // 当前文件占用的总字节数（用于内存上限保护）
    this.fileBytes = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("需要 WebSocket", { status: 400 });
    }
    const roomId = url.searchParams.get("room") || "";
    const pair = new WebSocketPair();
    this.handleSession(pair[1], roomId);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---- 连接生命周期 ----
  handleSession(ws, roomId) {
    ws.accept();
    const connectionId = genConnectionId();
    this.connections.set(connectionId, { ws, roomId, userId: null, token: null, lastSeen: Date.now() });

    ws.addEventListener("message", async (event) => {
      // 任意消息都刷新 lastSeen，并顺带清扫过期死连接（浏览器硬关闭兜底）
      const c = this.connections.get(connectionId);
      if (c) c.lastSeen = Date.now();
      this.sweepStaleConnections();

      let data;
      try { data = JSON.parse(event.data); }
      catch { return sendJSON(ws, { type: "error", message: "消息格式错误" }); }
      // 心跳包：仅用于保活与刷新 lastSeen，不进入业务路由
      if (data.type === "ping") return sendJSON(ws, { type: "pong" });
      try { await this.routeMessage(connectionId, data); }
      catch (err) { sendJSON(ws, { type: "error", message: "服务器处理异常: " + err.message }); }
    });
    ws.addEventListener("close", () => this.handleDisconnect(connectionId));
    ws.addEventListener("error", () => this.handleDisconnect(connectionId));
  }

  // 清扫长时间无心跳的死连接：关闭并按正常断开流程处理
  sweepStaleConnections() {
    const now = Date.now();
    for (const [cid, conn] of this.connections) {
      if (now - conn.lastSeen > CONN_STALE_MS) {
        // 已超 1 分钟无心跳：直接移除连接，并立即结束其会话（不再额外宽限）
        const { roomId, userId } = conn;
        this.connections.delete(cid);
        try { conn.ws.close(1001, "stale"); } catch {}
        if (roomId && userId && this.findConnectionsByUser(userId).length === 0) {
          if (this.leaveTimers.has(userId)) { clearTimeout(this.leaveTimers.get(userId)); this.leaveTimers.delete(userId); }
          this.finalizeLeave(roomId, userId);
        }
      }
    }
  }

  getRoomConnections() {
    return [...this.connections.entries()];
  }
  findConnectionsByUser(userId) {
    return this.getRoomConnections().filter((c) => c[1].userId === userId);
  }
  broadcast(obj, excludeUserId = null) {
    for (const [, conn] of this.connections) {
      if (excludeUserId !== null && conn.userId === excludeUserId) continue;
      sendJSON(conn.ws, obj);
    }
  }
  async broadcastUserList(roomId) {
    const order = await getOrder(this.env, roomId);
    this.broadcast({ type: "userList", users: buildUserList(order) });
  }
  async isOwner(roomId, userId) {
    const order = await getOrder(this.env, roomId);
    return order.length > 0 && order[0] === userId;
  }

  // 连接断开：进入宽限期，期满仍无同名连接才真正移除（房主刷新不会丢房主）
  async handleDisconnect(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.connections.delete(connectionId);
    const { roomId, userId } = conn;
    if (!roomId || !userId) return;

    // 同名仍有其它活跃连接（多标签页）-> 不处理
    if (this.findConnectionsByUser(userId).length > 0) return;

    // 启动宽限计时器
    if (this.leaveTimers.has(userId)) clearTimeout(this.leaveTimers.get(userId));
    const timer = setTimeout(() => this.finalizeLeave(roomId, userId), LEAVE_GRACE_MS);
    this.leaveTimers.set(userId, timer);
  }

  // 宽限期满：用户确实离开
  async finalizeLeave(roomId, userId) {
    this.leaveTimers.delete(userId);
    // 期间若已重连，则不处理
    if (this.findConnectionsByUser(userId).length > 0) return;

    let order = await getOrder(this.env, roomId);
    const wasOwner = order.length > 0 && order[0] === userId;
    order = order.filter((u) => u !== userId);
    await setOrder(this.env, roomId, order);
    this.broadcast({ type: "userLeft", userId });
    // 房主离开：房主顺延到下一位，广播 ownerChanged 让新房主拿到设置权限
    if (wasOwner && order.length > 0) {
      this.broadcast({ type: "ownerChanged", ownerId: order[0] });
    }
    await this.broadcastUserList(roomId);

    // 房间已空 -> 重置 KV 并清空历史与文件
    if (this.connections.size === 0) {
      await resetRoom(this.env, roomId);
      this.history = [];
      this.files.clear();
      this.fileBytes = 0;
    }
  }

  // ---- 消息路由 ----
  async routeMessage(connectionId, data) {
    switch (data.type) {
      case "hello": return this.handleHello(connectionId, data);
      case "join": return this.handleJoin(connectionId, data);
      case "message": return this.handleMessage(connectionId, data);
      case "kick": return this.handleKick(connectionId, data);
      case "blacklist": return this.handleBlacklist(connectionId, data);
      case "transfer": return this.handleTransfer(connectionId, data);
      case "updateSettings": return this.handleUpdateSettings(connectionId, data);
      // 文件：上传到房间（DO 内存）-> 文件消息进历史 -> 任何人按需下载
      case "fileUploadStart": return this.handleFileUploadStart(connectionId, data);
      case "fileUploadChunk": return this.handleFileUploadChunk(connectionId, data);
      case "fileUploadEnd": return this.handleFileUploadEnd(connectionId, data);
      case "fileDownload": return this.handleFileDownload(connectionId, data);
      default: {
        const conn = this.connections.get(connectionId);
        if (conn) sendJSON(conn.ws, { type: "error", message: "未知的消息类型: " + data.type });
      }
    }
  }

  // 第一段握手：返回房间是否存在 / 是否有密码 / 房间盐
  async handleHello(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    const ws = conn.ws;
    const roomCode = data.roomCode;
    if (!isValidRoomCode(roomCode)) {
      return sendJSON(ws, { type: "joinError", code: ERR.WRONG_CODE, message: "口令必须为 6 位数字" });
    }
    const settings = await getRoomSettings(this.env, roomCode);
    if (!settings) {
      return sendJSON(ws, { type: "roomInfo", exists: false, hasPassword: false, salt: null });
    }
    const salt = await getSalt(this.env, roomCode);
    sendJSON(ws, { type: "roomInfo", exists: true, hasPassword: !!settings.hasPassword, salt });
  }

  // 第二段握手：加入房间
  async handleJoin(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    const ws = conn.ws;
    const roomId = data.roomCode;
    const userId = (data.userId || "").toString().trim();
    const token = (data.token || "").toString();

    if (!isValidRoomCode(roomId)) {
      return sendJSON(ws, { type: "joinError", code: ERR.WRONG_CODE, message: "口令必须为 6 位数字" });
    }
    if (!userId) {
      return sendJSON(ws, { type: "joinError", code: ERR.WRONG_CODE, message: "昵称不能为空" });
    }

    let settings = await getRoomSettings(this.env, roomId);

    // 该昵称当前是否已在 order 中（已在册：刷新/重连/房主中途变更等）
    const order0 = settings ? await getOrder(this.env, roomId) : [];
    const isExistingInOrder = order0.includes(userId);

    // 同名的其它活跃连接（不含当前连接）
    const sameNameConns = this.findConnectionsByUser(userId).filter(([cid]) => cid !== connectionId);

    // 重名/重连判定（基于 token）：
    //   - 有同名活跃连接：若全部 token 与本次相同 => 同一人（同标签页）重连，接管并关闭旧连接；
    //     否则是不同的人占用了相同昵称 => 报重名要求改名。
    //   - 无同名活跃连接但宽限期内或已在 order => 视为重连（刷新/短暂断线）。
    let isReconnect = this.leaveTimers.has(userId) || isExistingInOrder;
    if (sameNameConns.length > 0) {
      const sameToken = token && sameNameConns.every(([, c]) => c.token === token);
      if (!sameToken) {
        return sendJSON(ws, { type: "joinError", code: ERR.NAME_TAKEN, message: "该昵称已被占用，请换一个昵称" });
      }
      // 同一人重连：接管，关闭旧连接（不触发离开流程，因为本连接立即顶上）
      for (const [cid, c] of sameNameConns) {
        this.connections.delete(cid);
        try { c.ws.close(1000, "superseded"); } catch {}
      }
      isReconnect = true;
    }

    if (!settings) {
      if (!data.salt) {
        return sendJSON(ws, { type: "joinError", code: ERR.WRONG_CODE, message: "缺少房间盐" });
      }
      const passwordHash = data.authHash ? await sha256Hex(data.salt + data.authHash) : null;
      await createRoom(this.env, roomId, data.salt, passwordHash);
      settings = { allowJoin: true, hasPassword: !!passwordHash };
    } else {
      const isExisting = isExistingInOrder;
      // 密码仅对【新加入用户】校验；已在册用户（重连/刷新/房主中途设密码）放行
      if (settings.hasPassword && !isExisting) {
        const salt = await getSalt(this.env, roomId);
        const stored = await getPassword(this.env, roomId);
        const provided = data.authHash ? await sha256Hex(salt + data.authHash) : null;
        if (!provided || provided !== stored) {
          return sendJSON(ws, { type: "joinError", code: ERR.WRONG_PASSWORD, message: "房间密码错误" });
        }
      }
      // 关闭加入：仅拦截新用户，已在册用户（重连/刷新）放行
      if (!settings.allowJoin && !isExisting) {
        return sendJSON(ws, { type: "joinError", code: ERR.ROOM_CLOSED, message: "房间已关闭" });
      }
      const blacklist = await getBlacklist(this.env, roomId);
      if (blacklist.includes(userId)) {
        return sendJSON(ws, { type: "joinError", code: ERR.BLACKLISTED, message: "你已被该房间拉黑" });
      }
    }

    // 重连：取消离开计时器，保留房主身份
    if (this.leaveTimers.has(userId)) {
      clearTimeout(this.leaveTimers.get(userId));
      this.leaveTimers.delete(userId);
    }

    conn.token = token;
    conn.roomId = roomId;
    conn.userId = userId;

    let order = await getOrder(this.env, roomId);
    if (!order.includes(userId)) {
      order.push(userId);
      await setOrder(this.env, roomId, order);
    }
    await touchRoom(this.env, roomId);

    sendJSON(ws, {
      type: "joined",
      roomId,
      selfId: userId,
      ownerId: order[0],
      users: buildUserList(order),
      history: this.history,
      settings: { allowJoin: settings.allowJoin, hasPassword: settings.hasPassword },
    });

    await this.broadcastUserList(roomId);
    // 仅当该昵称此前不在房间内（真正的新人）才广播"加入"提示，避免刷新/重连/接管时重复提示
    if (!isExistingInOrder && !isReconnect) this.broadcast({ type: "userJoined", userId }, userId);
  }

  // 文本消息中转（仅广播密文）
  async handleMessage(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    if (typeof data.content !== "string" || data.content.length > 16384) {
      return sendJSON(conn.ws, { type: "error", message: "消息内容非法或过长" });
    }
    const msg = {
      type: "message",
      msgId: typeof data.msgId === "string" ? data.msgId : undefined,
      content: data.content,
      senderId: conn.userId,
      senderName: conn.userId,
      timestamp: data.timestamp || Date.now(),
    };
    this.history.push(msg);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    await touchRoom(this.env, conn.roomId);
    // 广播给所有人（含发送者）：客户端统一从服务器广播渲染，避免按 userId 排除导致漏发
    this.broadcast(msg);
  }

  // ---- 文件：上传到房间内存 -> 文件消息进历史 -> 任何人按需下载 ----
  // 上传开始：登记文件元信息，准备接收分片
  async handleFileUploadStart(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    const meta = data.fileMeta;
    if (!meta || !meta.fileId || typeof meta.name !== "string") {
      return sendJSON(conn.ws, { type: "error", message: "文件元信息非法" });
    }
    if (typeof meta.size !== "number" || meta.size <= 0 || meta.size > MAX_FILE_BYTES) {
      return sendJSON(conn.ws, { type: "fileUploadError", fileId: meta.fileId, message: "文件超过 25MB 上限" });
    }
    if (this.fileBytes + meta.size > MAX_ROOM_FILE_BYTES) {
      return sendJSON(conn.ws, { type: "fileUploadError", fileId: meta.fileId, message: "房间文件总量超限，请稍后再试" });
    }
    if (this.files.has(meta.fileId)) return; // 重复开始忽略
    this.files.set(meta.fileId, {
      meta: { fileId: meta.fileId, name: meta.name, size: meta.size, chunks: meta.chunks },
      senderId: conn.userId,
      parts: new Array(meta.chunks),
      bytes: 0,
      done: false,
    });
  }

  // 上传分片：累积密文（服务器无法解密）
  async handleFileUploadChunk(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    const f = this.files.get(data.fileId);
    if (!f || f.done) return;
    if (typeof data.data !== "string" || data.data.length > 1500000) {
      return sendJSON(conn.ws, { type: "error", message: "文件分片非法或过大" });
    }
    if (f.parts[data.chunkIndex] !== undefined) return; // 重复分片忽略
    // 房间总量保护
    if (this.fileBytes + data.data.length > MAX_ROOM_FILE_BYTES) {
      this.files.delete(data.fileId);
      return sendJSON(conn.ws, { type: "fileUploadError", fileId: data.fileId, message: "房间文件总量超限" });
    }
    f.parts[data.chunkIndex] = data.data;
    f.bytes += data.data.length;
    this.fileBytes += data.data.length;
  }

  // 上传结束：生成文件消息进历史，并广播给房间所有人
  async handleFileUploadEnd(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    const f = this.files.get(data.fileId);
    if (!f || f.done) return;
    // 校验分片完整
    for (let i = 0; i < f.meta.chunks; i++) {
      if (f.parts[i] === undefined) {
        return sendJSON(conn.ws, { type: "fileUploadError", fileId: data.fileId, message: "分片缺失，上传失败" });
      }
    }
    f.done = true;

    const msg = {
      type: "message",
      kind: "file",
      fileId: f.meta.fileId,
      fileName: f.meta.name,
      fileSize: f.meta.size,
      chunks: f.meta.chunks,
      senderId: conn.userId,
      senderName: conn.userId,
      timestamp: data.timestamp || Date.now(),
    };
    this.history.push(msg);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    await touchRoom(this.env, conn.roomId);
    // 广播给所有人（含发送者，统一从历史/广播渲染文件消息）
    this.broadcast(msg);
    // 单独回执发送者：上传完成
    sendJSON(conn.ws, { type: "fileUploaded", fileId: f.meta.fileId });
  }

  // 下载：把某文件的所有密文分片回传给请求者，由其本地解密
  async handleFileDownload(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    const f = this.files.get(data.fileId);
    if (!f || !f.done) {
      return sendJSON(conn.ws, { type: "fileDownloadError", fileId: data.fileId, message: "文件不存在或已过期" });
    }
    sendJSON(conn.ws, {
      type: "fileDownloadStart",
      fileId: f.meta.fileId, name: f.meta.name, size: f.meta.size, chunks: f.meta.chunks,
    });
    for (let i = 0; i < f.meta.chunks; i++) {
      sendJSON(conn.ws, { type: "fileDownloadChunk", fileId: f.meta.fileId, chunkIndex: i, data: f.parts[i] });
    }
    sendJSON(conn.ws, { type: "fileDownloadEnd", fileId: f.meta.fileId });
  }

  // ---- 房主操作 ----
  async handleKick(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    if (!(await this.isOwner(conn.roomId, conn.userId))) {
      return sendJSON(conn.ws, { type: "error", message: "只有房主可以踢人" });
    }
    const targetId = data.targetId;
    if (targetId === conn.userId) return;
    // 立即移出 order，避免被踢者靠重连绕过
    let order = await getOrder(this.env, conn.roomId);
    order = order.filter((u) => u !== targetId);
    await setOrder(this.env, conn.roomId, order);
    for (const [, c] of this.findConnectionsByUser(targetId)) {
      sendJSON(c.ws, { type: "kicked", message: "你已被房主移出房间" });
      try { c.ws.close(1000, "kicked"); } catch {}
    }
    this.broadcast({ type: "userKicked", userId: targetId });
    await this.broadcastUserList(conn.roomId);
  }

  async handleBlacklist(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    if (!(await this.isOwner(conn.roomId, conn.userId))) {
      return sendJSON(conn.ws, { type: "error", message: "只有房主可以拉黑" });
    }
    const targetId = data.targetId;
    if (targetId === conn.userId) return;
    if (data.action === "add") {
      const blacklist = await getBlacklist(this.env, conn.roomId);
      if (!blacklist.includes(targetId)) {
        blacklist.push(targetId);
        await kvPutJSON(this.env, kvKey.blacklist(conn.roomId), blacklist);
      }
      let order = await getOrder(this.env, conn.roomId);
      order = order.filter((u) => u !== targetId);
      await setOrder(this.env, conn.roomId, order);
      for (const [, c] of this.findConnectionsByUser(targetId)) {
        sendJSON(c.ws, { type: "blacklisted", message: "你已被房主拉黑" });
        try { c.ws.close(1000, "blacklisted"); } catch {}
      }
      this.broadcast({ type: "userBlacklisted", userId: targetId });
      await this.broadcastUserList(conn.roomId);
    }
  }

  async handleTransfer(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    if (!(await this.isOwner(conn.roomId, conn.userId))) {
      return sendJSON(conn.ws, { type: "error", message: "只有房主可以转让" });
    }
    const targetId = data.targetId;
    let order = await getOrder(this.env, conn.roomId);
    const targetIdx = order.indexOf(targetId);
    if (targetIdx <= 0) return;
    const oldOwner = order[0];
    order[0] = targetId;
    order[targetIdx] = oldOwner;
    await setOrder(this.env, conn.roomId, order);
    this.broadcast({ type: "ownerChanged", ownerId: targetId });
    await this.broadcastUserList(conn.roomId);
  }

  // 房主设置：允许加入 / 修改/取消密码
  async handleUpdateSettings(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.roomId) return;
    if (!(await this.isOwner(conn.roomId, conn.userId))) {
      return sendJSON(conn.ws, { type: "error", message: "只有房主可以修改房间设置" });
    }
    const roomId = conn.roomId;
    const settings = (await getRoomSettings(this.env, roomId)) || { allowJoin: true, hasPassword: false };
    let passwordChanged = false;
    let encPassword = null; // 用房间密钥加密的新密码密文（服务器只转发，无法解密）

    if (typeof data.allowJoin === "boolean") settings.allowJoin = data.allowJoin;

    if (data.password && typeof data.password === "object") {
      const salt = await getSalt(this.env, roomId);
      if (data.password.action === "set" && data.password.authHash) {
        await this.env.ROOM_KV.put(kvKey.password(roomId), await sha256Hex(salt + data.password.authHash));
        settings.hasPassword = true;
        passwordChanged = true;
        // 房主附带的密码密文（AES，房间密钥加密），转发给已在房成员自动填入
        if (typeof data.password.encPassword === "string") encPassword = data.password.encPassword;
      } else if (data.password.action === "clear") {
        await this.env.ROOM_KV.delete(kvKey.password(roomId));
        settings.hasPassword = false;
        passwordChanged = true;
      }
    }

    await kvPutJSON(this.env, kvKey.settings(roomId), settings);
    this.broadcast({
      type: "settings",
      settings: { allowJoin: settings.allowJoin, hasPassword: settings.hasPassword },
      passwordChanged,
      encPassword, // set 时为密文，clear/未改密码时为 null
    });
  }
}

// =============================================================================
// Worker 入口：HTTP 路由
// =============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 微信域名安全验证：微信要求在网站根目录放一个指定名称的 txt 文件并返回指定内容。
    // 本站是纯 Worker（无静态文件系统），故用路由返回该文件内容。
    // 如日后微信要求更换文件名/内容，只需修改这两个常量即可。
    const WECHAT_VERIFY_FILE = "692809c239bb348430f0cbbadbbacf93.txt";
    const WECHAT_VERIFY_CONTENT = "a428cf1e0f077b682473d23ad24b7d8e438667cc";
    if (url.pathname === "/" + WECHAT_VERIFY_FILE) {
      return new Response(WECHAT_VERIFY_CONTENT, {
        headers: { "Content-Type": "text/plain;charset=UTF-8", "Cache-Control": "no-cache" },
      });
    }

    // WebSocket 升级：按房间口令路由到唯一的 Durable Object 实例
    if (url.pathname === "/websocket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("需要 WebSocket", { status: 400 });
      }
      const roomCode = url.searchParams.get("room") || "";
      if (!isValidRoomCode(roomCode)) {
        return new Response("房间口令非法", { status: 400 });
      }
      const id = env.CHAT_ROOM.idFromName(roomCode);
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // Service Worker 脚本（用于应用外壳缓存，可选）
    if (url.pathname === "/sw.js") {
      return new Response(SW, {
        headers: {
          "Content-Type": "application/javascript;charset=UTF-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 其它路径返回前端页面（带安全响应头）
    return new Response(HTML, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        "Content-Security-Policy": [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self' wss: ws:",
          "img-src 'self' data: https:",
          "base-uri 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    });
  },
};
