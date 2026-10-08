import type { ClientMsg, ServerMsg } from '../../shared/src/protocol.ts';

type Handler = (m: ServerMsg) => void;

// one socket, reconnects with backoff; the server re-sends hello/pot on every connect
export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private backoff = 500;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.backoff = 500; this.onOpen?.(); };
    ws.onmessage = (e) => { let m: ServerMsg; try { m = JSON.parse(e.data); } catch { return; } for (const h of this.handlers) h(m); };
    ws.onclose = () => {
      this.onClose?.();
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 2);
    };
  }
  on(h: Handler) { this.handlers.push(h); }
  send(m: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
}
