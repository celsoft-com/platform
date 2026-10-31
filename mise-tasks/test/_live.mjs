// Checks a preview's live rooms over real WebSockets; run by the test:preview task.
const [base, cookie] = process.argv.slice(2);
// Prints the answer, and fails the run unless it equals what was expected.
const check = (label, expected, value) => {
  const ok = String(value) === expected;
  console.log(`${label.padEnd(44)} ${value}${ok ? "" : `   FAILED, expected ${expected}`}`);
  if (!ok) process.exitCode = 1;
};
const headers = { cookie, origin: base };
// The served client is minified with the Worker, so it must still load on its own and export `live`.
const client = await (await fetch(`${base}/api/live/client.js`)).text();
check("live client loads as a module", "function", typeof (await import(`data:text/javascript,${encodeURIComponent(client)}`)).live);
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


const org = await api("/api/organizations", { name: "Live" });
const room = open(`organization:${org.id}`);
// A preview's first room can take several seconds to start, so the first frame gets longer.
check("join own organization room", "hello", (await room.until((f) => f.type === "hello", 30000)) ? "hello" : `nothing; got ${room.frames.map((f) => f.type).join(",")}`);
check("presence lists me", "yes", (await room.until((f) => f.type === "presence" && f.people.length === 1)) ? "yes" : "no");

await api(`/api/organizations/${org.id}/notes`, { body: "live note" });
const note = await room.until((f) => f.type === "message" && f.data?.type === "note");
check("organization note arrives live", "live note", note?.data?.note?.body ?? "nothing");

room.socket.send(JSON.stringify({ data: { type: "typing" } }));
check("browser message acknowledged", "ack", (await room.until((f) => f.type === "ack")) ? "ack" : "nothing");
room.socket.close();

const stranger = open(`organization:${crypto.randomUUID()}`);
check("someone else's organization refused (4403)", "4403", await stranger.closed);
const odd = open(`note:${crypto.randomUUID()}`);
check("a room that is no organization refused (4403)", "4403", await odd.closed);
