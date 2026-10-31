import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

// Where the CLI talks to the person running it. A terminal asks; standard input answers when
// there is no terminal, as when a password is piped in; tests use a fake.
export interface Terminal {
  // A terminal, rather than piped input.
  readonly tty: boolean;
  // Someone is there to answer: a terminal, outside CI.
  readonly interactive: boolean;
  log(line: string): void;
  ask(question: string): Promise<string>;
  // Nothing typed is echoed.
  askSecret(question: string): Promise<string>;
  // True for y or yes.
  confirm(question: string): Promise<boolean>;
}

export function processTerminal(): Terminal {
  return process.stdin.isTTY ? ttyTerminal() : stdinTerminal();
}

const log = (line: string) => console.log(line);

function ttyTerminal(): Terminal {
  const ask = async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  return {
    tty: true,
    interactive: !process.env.CI,
    log,
    ask,
    async askSecret(question) {
      let muted = false;
      const output = new Writable({ write: (chunk, _encoding, done) => (muted || process.stdout.write(chunk), done()) });
      const rl = createInterface({ input: process.stdin, output, terminal: true });
      try {
        process.stdout.write(question);
        muted = true;
        const answer = await rl.question("");
        muted = false;
        process.stdout.write("\n");
        return answer;
      } finally {
        rl.close();
      }
    },
    confirm: async (question) => /^y(es)?$/i.test((await ask(question)).trim()),
  };
}

// Piped input: each answer is the next line of it, read whole on the first question.
function stdinTerminal(): Terminal {
  let lines: Promise<string[]> | undefined;
  const next = async () => {
    lines ??= (async () => {
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      return input.split(/\r?\n/);
    })();
    return (await lines).shift() ?? "";
  };
  return { tty: false, interactive: false, log, ask: next, askSecret: next, confirm: async () => /^y(es)?$/i.test((await next()).trim()) };
}

// A terminal for tests: answers in order, and every line logged and question asked kept.
export function fakeTerminal(answers: string[] = [], { interactive = true } = {}): Terminal & { lines: string[] } {
  const lines: string[] = [];
  const next = async (question: string) => (lines.push(question), answers.shift() ?? "");
  return {
    tty: interactive,
    interactive,
    lines,
    log: (line) => void lines.push(line),
    ask: next,
    askSecret: next,
    confirm: async (question) => /^y(es)?$/i.test((await next(question)).trim()),
  };
}
