import {edgeCommandSchema, type EdgeCommand} from '../shared/contracts.js';
import type {PiClipId, PiCommandSink} from './pi.js';

export interface CommandExecutorOptions {
  dryRun: boolean;
  piCommandSink?: PiCommandSink;
  clipCooldownSeconds?: number;
}

function clipForCommand(command: EdgeCommand): PiClipId | undefined {
  switch (command.action) {
    case 'play_cached_clip':
      return 'thank_driver';
    case 'start_visitor_conversation':
      return 'greeting';
    case 'politely_decline':
      return 'no_soliciting';
    case 'ask_visitor_to_wait':
    case 'notify_homeowner':
      return 'please_wait';
    case 'friendly_costume_comment':
    case 'complete_interaction':
      return undefined;
  }
}

export class CommandExecutor {
  private readonly processedCommands = new Map<string, number>();
  private readonly lastClipPlaybackAt = new Map<PiClipId, number>();
  private readonly clipCooldownMilliseconds: number;

  constructor(private readonly options: CommandExecutorOptions) {
    if (!options.dryRun && !options.piCommandSink) {
      throw new Error('A Pi command sink is required when dry-run is disabled.');
    }

    const clipCooldownSeconds = options.clipCooldownSeconds ?? 60;
    if (!Number.isInteger(clipCooldownSeconds) || clipCooldownSeconds < 0) {
      throw new Error('clipCooldownSeconds must be a non-negative integer.');
    }
    this.clipCooldownMilliseconds = clipCooldownSeconds * 1_000;
  }

  recordLocalPlayback(clipId: PiClipId, playedAt = Date.now()): void {
    this.lastClipPlaybackAt.set(clipId, playedAt);
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

    const clipId = clipForCommand(command);
    if (!clipId) {
      console.info(
        `[executor] command ${command.command_id} action ${command.action} has no cached-audio mapping`,
      );
      this.processedCommands.set(command.command_id, expiresAt);
      return;
    }

    const lastPlaybackAt = this.lastClipPlaybackAt.get(clipId);
    if (
      lastPlaybackAt !== undefined &&
      now - lastPlaybackAt < this.clipCooldownMilliseconds
    ) {
      const remainingSeconds = Math.ceil(
        (this.clipCooldownMilliseconds - (now - lastPlaybackAt)) / 1_000,
      );
      console.info(
        `[executor] command ${command.command_id} clip ${clipId} suppressed; cooldown has ${remainingSeconds}s remaining`,
      );
      this.processedCommands.set(command.command_id, expiresAt);
      return;
    }

    const piCommand = {
      schema_version: '1.0' as const,
      command_id: command.command_id,
      action: 'play_cached_clip' as const,
      clip_id: clipId,
      expires_at: command.expires_at,
    };

    if (this.options.dryRun) {
      console.info(
        '[executor] dry-run Pi command',
        JSON.stringify({
          ...piCommand,
          case_id: command.case_id,
          cloud_action: command.action,
        }),
      );
    } else {
      await this.options.piCommandSink?.publish(piCommand);
      this.recordLocalPlayback(clipId, now);
      console.info(
        `[executor] published ${command.command_id} as Pi clip ${clipId}`,
      );
    }

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
