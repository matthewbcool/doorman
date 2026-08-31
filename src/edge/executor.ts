import {edgeCommandSchema, type EdgeCommand} from '../shared/contracts.js';
import type {DoormanEvent} from '../shared/contracts.js';
import type {PiClipId, PiCommandSink} from './pi.js';

export interface CommandExecutorOptions {
  dryRun: boolean;
  piCommandSink?: PiCommandSink;
  greetingCooldownSeconds: number;
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
    case 'relay_homeowner_message':
      return 'please_wait';
    case 'friendly_costume_comment':
    case 'complete_interaction':
      return undefined;
  }
}

export class CommandExecutor {
  private readonly processedCommands = new Map<string, number>();
  private readonly greetedZones = new Map<string, number>();
  private lastImmediateGreetingAt = 0;

  constructor(private readonly options: CommandExecutorOptions) {
    if (!options.dryRun && !options.piCommandSink) {
      throw new Error('A Pi command sink is required when dry-run is disabled.');
    }
  }

  async greetImmediately(event: DoormanEvent): Promise<boolean> {
    if (event.type !== 'person_entered') {
      return false;
    }
    const now = Date.now();
    const cooldownMs = this.options.greetingCooldownSeconds * 1_000;
    const lastGreeting = this.greetedZones.get(event.zone) ?? 0;
    if (now - lastGreeting < cooldownMs) {
      console.info(
        `[executor] immediate greeting suppressed for ${event.zone}; cooldown active`,
      );
      return false;
    }

    const commandId = `edge-greeting:${event.source_event_id}`;
    const expiresAt = new Date(now + 30_000).toISOString();
    if (this.options.dryRun) {
      console.info(
        '[executor] dry-run immediate greeting',
        JSON.stringify({command_id: commandId, zone: event.zone}),
      );
    } else {
      await this.options.piCommandSink?.publish({
        schema_version: '1.0',
        command_id: commandId,
        action: 'play_cached_clip',
        clip_id: 'greeting',
        expires_at: expiresAt,
      });
      console.info(
        `[executor] published immediate greeting for ${event.source_event_id}`,
      );
    }

    this.greetedZones.set(event.zone, now);
    this.lastImmediateGreetingAt = now;
    return true;
  }

  async execute(input: EdgeCommand): Promise<void> {
    const command = edgeCommandSchema.parse(input);
    const now = Date.now();
    this.prune(now);

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

    if (
      command.action === 'start_visitor_conversation' &&
      now - this.lastImmediateGreetingAt <
        this.options.greetingCooldownSeconds * 1_000
    ) {
      console.info(
        `[executor] cloud greeting ${command.command_id} suppressed; edge already greeted`,
      );
      this.processedCommands.set(command.command_id, expiresAt);
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
        JSON.stringify({...piCommand, case_id: command.case_id}),
      );
    } else {
      await this.options.piCommandSink?.publish(piCommand);
      console.info(
        `[executor] published ${command.command_id} as Pi clip ${clipId}`,
      );
    }
    this.processedCommands.set(command.command_id, expiresAt);
  }

  private prune(now: number): void {
    for (const [commandId, expiresAt] of this.processedCommands) {
      if (expiresAt <= now) {
        this.processedCommands.delete(commandId);
      }
    }
    const cooldownMs = this.options.greetingCooldownSeconds * 1_000;
    for (const [zone, greetedAt] of this.greetedZones) {
      if (now - greetedAt >= cooldownMs) {
        this.greetedZones.delete(zone);
      }
    }
  }
}
