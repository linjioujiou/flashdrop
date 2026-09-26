// P2P 信令房间（Durable Object，支持 WebSocket Hibernation，闲置零成本）
// 每个房间以配对码命名，最多容纳 sender + receiver 两个连接。
// 房间只转发信令（SDP / ICE / 控制消息），文件数据走 WebRTC 点对点直传。

export class SignalRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  get roomCode() {
    return this.state.id.name || '';
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') return new Response('Not Found', { status: 404 });
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const role = url.searchParams.get('role') === 'receiver' ? 'receiver' : 'sender';

    // 同一角色只允许一个连接
    if (this.state.getWebSockets(role).length > 0) {
      return new Response(JSON.stringify({ error: { code: 'room_full', message: '房间已被占用' } }),
        { status: 409, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [role]);

    if (role === 'receiver') {
      try {
        await this.env.DB.prepare('UPDATE p2p_sessions SET connected_at = ? WHERE code = ? AND status = \'active\'')
          .bind(Date.now(), this.roomCode).run();
      } catch {}
      // 通知发送方：接收端已就位
      for (const ws of this.state.getWebSockets('sender')) {
        try { ws.send(JSON.stringify({ type: 'peer-joined' })); } catch {}
      }
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg.type;

    if (type === 'ping') {
      try { ws.send('{"type":"pong"}'); } catch {}
      return;
    }

    // 记录传输元信息（管理后台展示用）
    if (type === 'meta') {
      this.env.DB.prepare('UPDATE p2p_sessions SET file_name = ?, file_size = ? WHERE code = ?')
        .bind(String(msg.fileName || '').slice(0, 255), Math.max(0, Number(msg.fileSize) || 0), this.roomCode)
        .run().catch(() => {});
    } else if (type === 'transfer-done') {
      this.env.DB.prepare("UPDATE p2p_sessions SET status = 'completed', completed_at = ? WHERE code = ?")
        .bind(Date.now(), this.roomCode).run().catch(() => {});
    }

    // 原样转发给另一个角色
    const targetRole = this.state.getWebSockets('sender').includes(ws) ? 'receiver' : 'sender';
    for (const peer of this.state.getWebSockets(targetRole)) {
      try { peer.send(raw); } catch {}
    }
  }

  webSocketClose(ws) {
    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws) {
        try { peer.send(JSON.stringify({ type: 'peer-left' })); } catch {}
      }
    }
  }

  webSocketError() {}
}
