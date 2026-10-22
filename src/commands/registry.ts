import type { Command } from './types.js';

export class CommandRegistry {
  private readonly byName = new Map<string, Command>();
  private readonly commands: Command[] = [];

  register(command: Command): this {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const key = name.toLowerCase();
      if (this.byName.has(key)) throw new Error(`Comando duplicado: ${key}`);
      this.byName.set(key, command);
    }
    this.commands.push(command);
    return this;
  }

  resolve(name: string): Command | undefined {
    return this.byName.get(name.toLowerCase());
  }

  all(): readonly Command[] {
    return this.commands;
  }
}
