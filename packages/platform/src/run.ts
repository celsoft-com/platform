export type Log = (line: string) => void;

export class Run {
  constructor(
    readonly dryRun: boolean,
    private readonly log: Log,
  ) {}

  async ensure<T>(label: string, find: () => Promise<T | undefined>, create: () => Promise<T>, placeholder: T): Promise<T> {
    const found = await find();
    if (found !== undefined) {
      this.log(`✓ ${label}`);
      return found;
    }
    return this.mutate(`create ${label}`, create, placeholder);
  }

  async mutate<T>(action: string, apply: () => Promise<T>, placeholder: T): Promise<T> {
    if (this.dryRun) {
      this.log(`~ would ${action}`);
      return placeholder;
    }
    const result = await apply();
    this.log(`+ ${action}`);
    return result;
  }

  note(line: string): void {
    this.log(`  ${line}`);
  }
}
