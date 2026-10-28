// The header a request carries an access link's token in. Shared by the Worker and the browser
// client, so it imports nothing.
export const LINK_HEADER = "x-access-link";

// Where a page posts a link token from its fragment, `{ link }`, to have it kept as a cookie, so
// requests that cannot carry the header, such as page visits and downloads, still count it.
export const LINK_EXCHANGE_PATH = "/api/platform/link";
