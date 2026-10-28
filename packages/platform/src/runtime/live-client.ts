// The browser side of live rooms. It has no imports and closes over nothing, so the runtime
// can also serve it as a script with `live.toString()`, for pages that have no bundler; the
// deploy minifies, so the served script names it itself rather than trusting its own name.

declare const location: { href: string; reload(): void };

export interface LivePeer {
  id: string;
  name: string;
}

export interface LiveHandlers {
  onMessage?(data: unknown, meta: { from: LivePeer | null; seq: number }): void;
  onPresence?(people: LivePeer[], anonymous: number): void;
  onStatus?(status: "open" | "closed" | "refused"): void;
  onError?(error: string): void;
  // Called when the room no longer holds everything this page missed; reloads the page by default.
  onReload?(): void;
}

export interface LiveConnection {
  send(data: unknown): boolean;
  close(): void;
}

export function live(room: string, handlers: LiveHandlers = {}): LiveConnection {
  let socket: WebSocket | undefined;
  let last: number | undefined;
  let stopped = false;
  let attempts = 0;

  const open = () => {
    const url = new URL(`/api/live/${encodeURIComponent(room)}`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (last !== undefined) url.searchParams.set("since", String(last));
    const current = new WebSocket(url);
    socket = current;
    current.onopen = () => {
      attempts = 0;
      handlers.onStatus?.("open");
    };
    current.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "hello") {
        if (last === undefined) last = frame.seq;
      } else if (frame.type === "message") {
        last = frame.seq;
        handlers.onMessage?.(frame.data, { from: frame.from, seq: frame.seq });
      } else if (frame.type === "ack") {
        last = Math.max(last ?? 0, frame.seq);
      } else if (frame.type === "presence") {
        handlers.onPresence?.(frame.people, frame.anonymous);
      } else if (frame.type === "reload") {
        last = undefined;
        if (handlers.onReload) handlers.onReload();
        else location.reload();
      } else if (frame.type === "error") {
        handlers.onError?.(frame.error);
      }
    };
    current.onclose = (event) => {
      if (socket !== current) return;
      // 4403 and 4404 mean the app refused this room; trying again would only be refused again.
      if (event.code === 4403 || event.code === 4404) {
        stopped = true;
        handlers.onStatus?.("refused");
        return;
      }
      handlers.onStatus?.("closed");
      if (!stopped) setTimeout(open, Math.min(15000, 500 * 2 ** attempts++));
    };
  };

  open();
  return {
    send(data) {
      if (socket?.readyState !== 1) return false;
      socket.send(JSON.stringify({ data }));
      return true;
    },
    close() {
      stopped = true;
      socket?.close();
    },
  };
}
