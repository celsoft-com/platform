// Checks a preview's live rooms over real WebSockets; run by the test:preview task.
const [base, cookie] = process.argv.slice(2);
const check = (label, value) => console.log(`${label.padEnd(44)} ${value}`);
const headers = { cookie, origin: base };
const api = async (path, body) => (await fetch(base + path, { method: body ? "POST" : "GET", headers: { ...headers, "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) })).json();

function open(room) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/live/${room}`, { headers });
  const frames = [];
  const closed = new Promise((resolve) => socket.addEventListener("close", (e) => resolve(e.code)));
  socket.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
  const until = async (test, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const found = frames.find(test);
      if (found) return found;
    }
    return undefined;
  };
  return { socket, frames, closed, until };
}

const client = await fetch(`${base}/api/live/client.js`);
check("client script served", `${client.status} ${(await client.text()).startsWith("export function live(")}`);

const team = await api("/api/auth/organization/create", { name: "Live", slug: `live-${Date.now()}` });
const room = open(`team:${team.id}`);
check("join own team room", (await room.until((f) => f.type === "hello")) ? "hello" : "nothing");
check("presence lists me", (await room.until((f) => f.type === "presence" && f.people.length === 1)) ? "yes" : "no");

await api(`/api/teams/${team.id}/notes`, { body: "live note" });
const note = await room.until((f) => f.type === "message" && f.data?.type === "note");
check("team note arrives live", note?.data?.note?.body ?? "nothing");

room.socket.send(JSON.stringify({ data: { type: "typing" } }));
check("browser message acknowledged", (await room.until((f) => f.type === "ack")) ? "ack" : "nothing");
room.socket.close();

const stranger = open(`team:${crypto.randomUUID()}`);
check("someone else's team refused (4403)", await stranger.closed);
