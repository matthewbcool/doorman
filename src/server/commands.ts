import type {EdgeCommand} from '../shared/contracts.js';

export interface CommandSink {
  publish(command: EdgeCommand): Promise<void>;
}

export class InMemoryCommandSink implements CommandSink {
  private readonly commands: EdgeCommand[] = [];

  async publish(command: EdgeCommand) {
    this.commands.push(structuredClone(command));
  }

  async list() {
    return this.commands.map((command) => structuredClone(command));
  }
}
