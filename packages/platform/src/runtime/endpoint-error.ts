// How an endpoint fails: over the API it is this status with `{ error }`, over MCP a tool error
// with the message. Shared by the Worker and the browser client, so it imports nothing.
export class EndpointError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

export interface Refusal {
  status: number;
  message: string;
}

// The one mapping from a thrown error to how a request is refused: an EndpointError's status and
// message, or a thrown Response's status and its `{ error }`, as requireUser throws; undefined for
// anything else, which is a bug. Each transport only formats it: JSON, oRPC, an MCP tool error or HTML.
export async function refusal(thrown: unknown): Promise<Refusal | undefined> {
  if (thrown instanceof EndpointError) return { status: thrown.status, message: thrown.message };
  if (thrown instanceof Response) {
    const { error } = (await thrown.clone().json().catch(() => ({}))) as { error?: string };
    return { status: thrown.status, message: error ?? thrown.statusText };
  }
  return undefined;
}
