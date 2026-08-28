import {edgeCommandSchema, type EdgeCommand} from '../shared/contracts.js';

export interface CommandExecutorOptions {
  dryRun: boolean;
}

export class CommandExecutor {
  private readonly processedCommands = new Map<string, number>();

  constructor(private readonly options: CommandExecutorOptions) {
    if (!options.dryRun) {
      throw new Error(
        'Physical command execution is not implemented. Set DOORMAN_EDGE_DRY_RUN=true.',
      );
    }
  }

  async execute(input: EdgeCommand): Promise<void> {
    const command = edgeCommandSchema.parse(input);
    const now = Date.now();
    this.pruneProcessedCommands(now);

    if (this.processedCommands.has(command.command_id)) {
      console.info(`[executor] duplicate command ${command.command_id} ignored`);
      return;
    }

    const expiresAt = Date.parse(command.expires_at);
    if (expiresAt <= now) {
      console.info(`[executor] expired command ${command.command_id} ignored`);
      this.processedCommands.set(command.command_id, now);
      return;
    }

    console.info(
      '[executor] dry-run command',
      JSON.stringify({
        command_id: command.command_id,
        case_id: command.case_id,
        action: command.action,
        response_text: command.response_text,
        expires_at: command.expires_at,
      }),
    );

    this.processedCommands.set(command.command_id, expiresAt);
  }

  private pruneProcessedCommands(now: number): void {
    for (const [commandId, expiresAt] of this.processedCommands) {
      if (expiresAt <= now) {
        this.processedCommands.delete(commandId);
      }
    }
  }
}
