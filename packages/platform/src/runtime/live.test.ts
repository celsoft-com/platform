import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KEPT_MESSAGES, liveRoom } from "./live.js";
import { defineApp } from "./index.js";
import { entryModule } from "../wrangler-config.js";

// A socket that records what it was sent, and the attachment a real one would keep.
class FakeSocket {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private attachment: unknown;
  accept() {}
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  of(type: string) {
    return this.sent.filter((f) => f.type === type);
  }
}

// Node's Response refuses status 101, which Workers use to hand over a WebSocket.
const RealResponse = globalThis.Response;
class UpgradeResponse extends RealResponse {
  readonly upgraded: unknown;
  constructor(body: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    super(body, { ...init, status: init?.status === 101 ? 200 : init?.status });
    this.upgraded = init?.webSocket;
  }
}

beforeAll(() => {
  globalThis.Response = UpgradeResponse as typeof Response;
  (globalThis as Record<string, unknown>).WebSocketPair = class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  };
});
afterAll(() => {
  globalThis.Response = RealResponse;
});

// The room's storage on a real SQLite database, the engine Durable Objects use.
function roomState() {
  const db = new DatabaseSync(":memory:");
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    // Like the real cursor, a statement runs as soon as it is executed, read or not.
    storage: {
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
          return { toArray: () => rows };
        },
      },
    },
    acceptWebSocket: (socket: FakeSocket) => void sockets.push(socket),
    getWebSockets: () => sockets,
    waitUntil: (p: Promise<unknown>) => void p,
  };
}

const ann = { id: "u1", name: "Ann" };
const bob = { id: "u2", name: "Bob" };
const joinRequest = (user: typeof ann | null, canSend: boolean, since?: number) =>
  new Request(`https://room/join${since === undefined ? "" : `?since=${since}`}`, { headers: { "x-attachment": JSON.stringify({ room: "note:1", user, canSend }) } });

describe("live room", () => {
  let state: ReturnType<typeof roomState>;
  let heard: unknown[];
  let room: { fetch(request: Request): Promise<Response>; webSocketMessage(s: FakeSocket, raw: string): Promise<void>; webSocketClose(s: FakeSocket, code: number, reason: string): void };
  const join = async (user: typeof ann | null, canSend = false, since?: number) => {
    await room.fetch(joinRequest(user, canSend, since));
    return state.sockets.at(-1)!;
  };
  const publish = (data: unknown) => room.fetch(new Request("https://room/publish", { method: "POST", body: JSON.stringify(data) }));

  beforeEach(() => {
    state = roomState();
    heard = [];
    const Room = liveRoom(() => async (_room, message, from) => void heard.push({ message, from }));
    room = new Room(state, {}) as unknown as typeof room;
  });

  it("delivers server messages to everyone, numbered", async () => {
    const a = await join(ann);
    const b = await join(bob);
    await publish({ title: "x" });
    expect(a.of("message")).toEqual([{ type: "message", seq: 1, from: null, data: { title: "x" } }]);
    expect(b.of("message")).toEqual(a.of("message"));
  });

  it("refuses a browser message unless the app allowed sending", async () => {
    const a = await join(ann, false);
    const b = await join(bob, true);
    await room.webSocketMessage(a, JSON.stringify({ data: "hi" }));
    expect(a.of("error")).toHaveLength(1);
    expect(b.of("message")).toEqual([]);
  });

  it("stamps a browser message with its sender, sends it to everyone else, and hands it to onMessage", async () => {
    const a = await join(ann, true);
    const b = await join(bob, true);
    await room.webSocketMessage(a, JSON.stringify({ data: { cursor: 4 } }));
    expect(b.of("message")).toEqual([{ type: "message", seq: 1, from: ann, data: { cursor: 4 } }]);
    expect(a.of("message")).toEqual([]);
    expect(a.of("ack")).toEqual([{ type: "ack", seq: 1 }]);
    expect(heard).toEqual([{ message: { cursor: 4 }, from: ann }]);
  });

  it("refuses messages over the size limit", async () => {
    const a = await join(ann, true);
    await room.webSocketMessage(a, JSON.stringify({ data: "x".repeat(70_000) }));
    expect(a.of("error")).toHaveLength(1);
  });

  it("catches a returning browser up on what it missed, senders included", async () => {
    const a = await join(ann, true);
    await publish("one");
    await room.webSocketMessage(a, JSON.stringify({ data: "two" }));
    const back = await join(bob, false, 0);
    expect(back.of("message").map((f) => [f.seq, f.from, f.data])).toEqual([[1, null, "one"], [2, ann, "two"]]);
  });

  it("tells a browser gone too long to reload", async () => {
    for (let i = 0; i < KEPT_MESSAGES + 10; i++) await publish(i);
    const back = await join(ann, false, 3);
    expect(back.of("reload")).toHaveLength(1);
    expect(back.of("message")).toEqual([]);
  });

  it("tells everyone who is here on each join and leave", async () => {
    const a = await join(ann);
    await join(bob);
    await join(null);
    expect(a.of("presence").at(-1)).toEqual({ type: "presence", people: [ann, bob], anonymous: 1 });
    const bobSocket = state.sockets[1]!;
    state.sockets.splice(1, 1);
    room.webSocketClose(bobSocket, 1000, "bye");
    expect(a.of("presence").at(-1)).toEqual({ type: "presence", people: [ann], anonymous: 1 });
  });
});

describe("live routes", () => {
  const env = { LIVE_ROOMS: "on", LIVE: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("room") }) } };
  const ctx = { waitUntil: () => {} };
  const upgrade = { headers: { upgrade: "websocket" } };

  it("serves the browser client as a module", async () => {
    const response = await defineApp(() => new Response("app")).fetch(new Request("https://x/api/live/client.js"), env, ctx);
    expect(await response.text()).toMatch(/^export function live\(/);
  });

  it("refuses to join unless the app's canJoin agrees", async () => {
    const response = (await defineApp(() => new Response("app")).fetch(new Request("https://x/api/live/note:1", upgrade), env, ctx)) as UpgradeResponse;
    expect(response.upgraded).toBeInstanceOf(FakeSocket);
    expect(await response.text()).not.toBe("room");
  });

  it("passes an allowed join through to the room", async () => {
    const app = defineApp(() => new Response("app"), { live: { canJoin: () => true } });
    expect(await (await app.fetch(new Request("https://x/api/live/note:1", upgrade), env, ctx)).text()).toBe("room");
  });

  it("leaves /api/live to the app when live rooms are off", async () => {
    const response = await defineApp(() => new Response("app")).fetch(new Request("https://x/api/live/client.js"), { ...env, LIVE_ROOMS: "off" }, ctx);
    expect(await response.text()).toBe("app");
  });
});

describe("entryModule", () => {
  it("exports the app's handler and its room class", () => {
    expect(entryModule("src/worker.ts")).toContain('import app from "./src/worker.ts";\nexport default app;\nexport const LiveRoom = app.LiveRoom;');
  });
});
