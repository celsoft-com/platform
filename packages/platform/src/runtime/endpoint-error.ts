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
