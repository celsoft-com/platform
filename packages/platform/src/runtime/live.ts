import { live as client } from "./live-client.js";
import type { LivePeer } from "./live-client.js";

// Live rooms: one Durable Object per room name, holding the open sockets, a numbered window of
// recent messages for catching up, and who is connected. Rooms carry messages only; what they
// mean and whether anything is saved is the app's business.

export const LIVE_PATH = "/api/live/";
export const CLIENT_PATH = `${LIVE_PATH}client.js`;
export const MAX_MESSAGE = 64 * 1024;
export const KEPT_MESSAGES = 500;
const ROOM_NAME = /^[A-Za-z0-9:_.-]{1,200}$/;

// The subset of Cloudflare's Durable Object types the runtime uses, so it needs no Workers types.
export interface LiveNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface RoomSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface RoomState {
  storage: { sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } } };
  acceptWebSocket(socket: RoomSocket): void;
  getWebSockets(): RoomSocket[];
  waitUntil(promise: Promise<unknown>): void;
}

declare const WebSocketPair: { new (): { 0: RoomSocket; 1: RoomSocket } };

interface Attachment {
  room: string;
  user: LivePeer | null;
  canSend: boolean;
}

export interface Live {
  publish(room: string, message: unknown): Promise<void>;
}

export const clientScript = () =>
  new Response(`export ${client.toString()}\n`, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });

const roomStub = (namespace: LiveNamespace, room: string) => namespace.get(namespace.idFromName(room));

export function createLive(namespace: LiveNamespace | undefined, enabled: boolean): Live {
  return {
    async publish(room, message) {
      if (!enabled || !namespace) throw new Error("this app has no live rooms; set `live: true` in platform.jsonc");
      if (!ROOM_NAME.test(room)) throw new Error(`invalid room name ${room}`);
      const body = JSON.stringify(message);
      if (body.length > MAX_MESSAGE) throw new Error(`live messages are limited to ${MAX_MESSAGE} bytes`);
      const response = await roomStub(namespace, room).fetch(new Request("https://room/publish", { method: "POST", headers: { "x-room": room }, body }));
      if (!response.ok) throw new Error(`publishing to ${room} failed: ${response.status}`);
    },
  };
}

// A refusal is sent as a closed socket with a reason, so the browser client knows to stop retrying.
function refuse(code: 4403 | 4404, reason: string): Response {
  const pair = new WebSocketPair();
  const socket = pair[1] as RoomSocket & { accept(): void };
  socket.accept();
  socket.close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
}

export interface JoinDecision {
  user: LivePeer | null;
  canJoin: boolean;
  canSend: boolean;
}

// The Worker decides who joins and who may send; the room trusts what it is told, since only
// the Worker can reach it.
export async function joinRoom(request: Request, url: URL, namespace: LiveNamespace, decide: (room: string) => Promise<JoinDecision>): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
  const room = decodeURIComponent(url.pathname.slice(LIVE_PATH.length));
  if (!ROOM_NAME.test(room)) return refuse(4404, "no such room");
  const { user, canJoin, canSend } = await decide(room);
  if (!canJoin) return refuse(4403, "not allowed to join");

  const headers = new Headers(request.headers);
  headers.set("x-room", room);
  headers.set("x-attachment", JSON.stringify({ room, user, canSend } satisfies Attachment));
  const since = url.searchParams.get("since");
  return roomStub(namespace, room).fetch(new Request(`https://room/join${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers }));
}

export type OnMessage = (room: string, message: unknown, from: LivePeer | null) => Promise<void>;

// The Durable Object class behind every room. The deploy's generated entry module exports it,
// built with the app's own onMessage, so apps never export platform code themselves.
export interface LiveRoomClass {
  new (state: unknown, env: unknown): { fetch(request: Request): Promise<Response> };
}

export function liveRoom(onMessage: (env: unknown) => OnMessage | undefined): LiveRoomClass {
  return class LiveRoom {
    readonly state: RoomState;

    constructor(
      state: unknown,
      readonly env: unknown,
    ) {
      this.state = state as RoomState;
      this.state.storage.sql.exec("create table if not exists messages (seq integer primary key autoincrement, body text not null, sender text not null)");
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/publish") {
        this.deliver(await request.text(), null);
        return new Response(null, { status: 204 });
      }

      const attachment = JSON.parse(request.headers.get("x-attachment") ?? "null") as Attachment;
      const pair = new WebSocketPair();
      const socket = pair[1];
      this.state.acceptWebSocket(socket);
      socket.serializeAttachment(attachment);
      socket.send(JSON.stringify({ type: "hello", seq: this.latest() }));
      const since = url.searchParams.get("since");
      if (since !== null) this.catchUp(socket, Number(since));
      this.presence();
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }

    async webSocketMessage(socket: RoomSocket, raw: string | ArrayBuffer): Promise<void> {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (!attachment.canSend) return socket.send(JSON.stringify({ type: "error", error: "not allowed to send to this room" }));
      if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return socket.send(JSON.stringify({ type: "error", error: `messages are text up to ${MAX_MESSAGE} bytes` }));
      let data: unknown;
      try {
        data = (JSON.parse(raw) as { data?: unknown }).data;
      } catch {
        return socket.send(JSON.stringify({ type: "error", error: "messages are JSON" }));
      }
      const seq = this.deliver(JSON.stringify(data ?? null), attachment.user, socket);
      socket.send(JSON.stringify({ type: "ack", seq }));
      const hook = onMessage(this.env);
      if (hook) this.state.waitUntil(hook(attachment.room, data, attachment.user));
    }

    webSocketClose(socket: RoomSocket, code: number, reason: string): void {
      try {
        socket.close(code, reason);
      } catch {
        // already closed
      }
      this.presence(socket);
    }

    webSocketError(socket: RoomSocket): void {
      this.presence(socket);
    }

    latest(): number {
      return Number(this.state.storage.sql.exec("select coalesce(max(seq), 0) as seq from messages").toArray()[0]!.seq);
    }

    // A browser gone longer than the kept window can only be told to reload.
    catchUp(socket: RoomSocket, since: number): void {
      const oldest = Number(this.state.storage.sql.exec("select coalesce(min(seq), 0) as seq from messages").toArray()[0]!.seq);
      if (since + 1 < oldest) return socket.send(JSON.stringify({ type: "reload" }));
      for (const row of this.state.storage.sql.exec("select seq, body, sender from messages where seq > ? order by seq", since).toArray()) {
        socket.send(`{"type":"message","seq":${row.seq},"from":${row.sender},"data":${row.body}}`);
      }
    }

    deliver(body: string, from: LivePeer | null, except?: RoomSocket): number {
      const sender = JSON.stringify(from);
      const seq = Number(this.state.storage.sql.exec("insert into messages (body, sender) values (?, ?) returning seq", body, sender).toArray()[0]!.seq);
      this.state.storage.sql.exec("delete from messages where seq <= ?", seq - KEPT_MESSAGES);
      const frame = `{"type":"message","seq":${seq},"from":${sender},"data":${body}}`;
      for (const socket of this.state.getWebSockets()) if (socket !== except) trySend(socket, frame);
      return seq;
    }

    presence(leaving?: RoomSocket): void {
      const sockets = this.state.getWebSockets().filter((s) => s !== leaving);
      const people = new Map<string, LivePeer>();
      let anonymous = 0;
      for (const socket of sockets) {
        const { user } = socket.deserializeAttachment() as Attachment;
        if (user) people.set(user.id, user);
        else anonymous++;
      }
      const frame = JSON.stringify({ type: "presence", people: [...people.values()], anonymous });
      for (const socket of sockets) trySend(socket, frame);
    }
  };
}

function trySend(socket: RoomSocket, frame: string): void {
  try {
    socket.send(frame);
  } catch {
    // the socket closed between listing and sending; its close handler updates presence
  }
}
