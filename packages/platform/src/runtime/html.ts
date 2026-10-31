// The one HTML document the platform renders, for its screens and its error and 404 pages.

export const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// `title` and `body` are HTML as given; `appName` and `stylesheet` are escaped here. `page` marks a
// platform screen, so the screens' style and an app's restyling apply to it.
export function htmlDocument({ title, appName, stylesheet, style, page, body, script }: { title: string; appName?: string; stylesheet?: string; style?: string; page?: string; body: string; script?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}${appName ? ` · ${escape(appName)}` : ""}</title>
${style ? `<style>${style}</style>` : ""}${stylesheet ? `<link rel="stylesheet" href="${escape(stylesheet)}">` : ""}
</head><body${page ? ` class="platform-screen" data-page="${page}"` : ""}>
${body}
${script ? `<script>${script}</script>\n` : ""}</body></html>`;
}
