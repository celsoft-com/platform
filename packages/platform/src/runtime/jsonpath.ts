import { JSONPathEnvironment, JSONPathError, jsonpath } from "json-p3";
import { z } from "zod";
import { EndpointError } from "./endpoint-error.js";

// JSONPath, RFC 9535, over JSON an app holds or keeps in app.files.

export const EXPRESSION_LIMIT = 1000;
export const PATTERN_LIMIT = 100;
export const QUERY_LIMIT = 1000;
export const DEFAULT_QUERY_LIMIT = 100;

export interface QueryOptions {
  // How many matches to return, 0 for only the total; 100 by default, at most 1,000.
  limit?: number;
  // How many matches to skip before the first returned.
  offset?: number;
}

export interface QueryResult {
  // Each match's value and its normalized path, such as $[3] or $['books'][0].
  items: { path: string; value: unknown }[];
  // Every match, however many `limit` returns.
  total: number;
}

// The RFC's regex functions, with patterns capped: a pattern is an I-Regexp, which has no
// back-references, but a long one with nested repeats can still be slow.
const checkPattern = (name: string, pattern: string) => {
  if (typeof pattern === "string" && pattern.length > PATTERN_LIMIT) throw new JSONPathError(`${name}() takes a pattern of at most ${PATTERN_LIMIT} characters`);
};

class Match extends jsonpath.functions.Match {
  override call(str: string, pattern: string): boolean {
    checkPattern("match", pattern);
    return super.call(str, pattern);
  }
}

class Search extends jsonpath.functions.Search {
  override call(str: string, pattern: string): boolean {
    checkPattern("search", pattern);
    return super.call(str, pattern);
  }
}

const environment = new JSONPathEnvironment();
environment.functions["match"] = new Match();
environment.functions["search"] = new Search();

// Checks an expression without running it; the message says what is wrong and where.
export function checkJsonPath(expression: string): string | undefined {
  if (expression.length > EXPRESSION_LIMIT) return `a JSONPath expression is at most ${EXPRESSION_LIMIT} characters`;
  try {
    environment.compile(expression);
    return undefined;
  } catch (error) {
    return message(error);
  }
}

// A refused expression or option is the caller's mistake, so it is a 400.
export function query(data: unknown, expression: string, options: QueryOptions = {}): QueryResult {
  const limit = options.limit ?? DEFAULT_QUERY_LIMIT;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 0 || limit > QUERY_LIMIT) throw new EndpointError(400, `a query's limit is 0 to ${QUERY_LIMIT}`);
  if (!Number.isInteger(offset) || offset < 0) throw new EndpointError(400, "a query's offset is 0 or more");
  const problem = checkJsonPath(expression);
  if (problem) throw new EndpointError(400, problem);
  const items: QueryResult["items"] = [];
  let total = 0;
  try {
    for (const node of environment.findIter(expression, data as never)) {
      if (total >= offset && items.length < limit) items.push({ path: node.normalizedPath(), value: node.value });
      total++;
    }
  } catch (error) {
    if (error instanceof JSONPathError) throw new EndpointError(400, message(error));
    throw error;
  }
  return { items, total };
}

// An endpoint input field holding a JSONPath expression, refused before the handler when it
// does not parse: `input: z.object({ where: jsonPath() })`.
export function jsonPath() {
  return z.string().superRefine((expression, ctx) => {
    const problem = checkJsonPath(expression);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
}

// json-p3's first line, with the character it points at, counting from 1.
function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const text = error.message.split("\n")[0]!;
  const start = (error as { span?: { start?: number } }).span?.start;
  return typeof start === "number" ? `${text} at ${start + 1}` : text;
}
