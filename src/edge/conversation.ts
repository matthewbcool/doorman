import {
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import mqtt, {type MqttClient} from 'mqtt';

import {
  doormanLiveInstruction,
  doormanLiveModel,
  doormanLiveVoice,
} from '../shared/live.js';
import type {PiCommandSink} from './pi.js';
import type {LiveTokenBrokerClient} from './token-broker.js';

export interface ConversationBridgeOptions {
  mqttUrl: string;
  piCommandSink: PiCommandSink;
  tokenBroker: LiveTokenBrokerClient;
  timeoutSeconds: number;
  inputTopicPrefix: string;
  outputTopicPrefix: string;
  controlTopicPrefix: string;
  username?: string;
  password?: string;
}

interface ActiveConversation {
  sessionId: string;
  sourceEventId: string;
  liveSession?: Session;
  closed: boolean;
  speaking: boolean;
  timeout: NodeJS.Timeout;
  outputChain: Promise<void>;
}

function topic(prefix: string, sessionId: string): string {
  return `${prefix}/${sessionId}`;
}

export class ConversationBridge {
  private mqttClient?: MqttClient;
  private active?: ActiveConversation;

  constructor(private readonly options: ConversationBridgeOptions) {}

  async start(): Promise<void> {
    if (this.mqttClient) {
      return;
    }

    const client = mqtt.connect(this.options.mqttUrl, {
      clientId: `doorman-edge-live-${process.pid}`,
      username: this.options.username,
      password: this.options.password,
      reconnectPeriod: 1_000,
      connectTimeout: 10_000,
      clean: true,
    });

    client.on('message', (incomingTopic, payload) => {
      this.forwardMicrophoneAudio(incomingTopic, payload);
    });
    client.on('error', (error) => {
      console.error('[conversation] MQTT client error', error);
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        client.off('error', onInitialError);
        client.subscribe(
          `${this.options.inputTopicPrefix}/+`,
          {qos: 0},
          (error) => (error ? reject(error) : resolve()),
        );
      };
      const onInitialError = (error: Error) => {
        client.off('connect', onConnect);
        client.end(true);
        reject(error);
      };
      client.once('connect', onConnect);
      client.once('error', onInitialError);
    });

    this.mqttClient = client;
    console.info(
      `[conversation] ready on ${this.options.inputTopicPrefix}/+ using ${doormanLiveModel}`,
    );
  }

  async open(sourceEventId: string): Promise<void> {
    if (!this.mqttClient?.connected) {
      throw new Error('Conversation MQTT bridge is not connected.');
    }
    if (this.active && !this.active.closed) {
      console.info(
        `[conversation] keeping active session ${this.active.sessionId}; ignored ${sourceEventId}`,
      );
      return;
    }

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + this.options.timeoutSeconds * 1_000,
    ).toISOString();
    const active: ActiveConversation = {
      sessionId,
      sourceEventId,
      closed: false,
      speaking: false,
      timeout: setTimeout(() => {
        void this.close('timeout');
      }, this.options.timeoutSeconds * 1_000),
      outputChain: Promise.resolve(),
    };
    this.active = active;

    try {
      const credential = await this.options.tokenBroker.createCredential();
      if (active.closed || this.active !== active) {
        return;
      }
      const ai = new GoogleGenAI({
        apiKey: credential.token,
        httpOptions: {apiVersion: 'v1beta'},
      });
      const liveSession = await ai.live.connect({
        model: credential.model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {voiceName: credential.voice},
            },
          },
          systemInstruction: doormanLiveInstruction,
        },
        callbacks: {
          onopen: () => {
            console.info(`[conversation] Gemini Live opened ${sessionId}`);
          },
          onmessage: (message: LiveServerMessage) => {
            active.outputChain = active.outputChain
              .then(() => this.handleLiveMessage(active, message))
              .catch((error) => {
                console.error('[conversation] output forwarding failed', error);
                void this.close('output_error');
              });
          },
          onerror: (event) => {
            console.error('[conversation] Gemini Live error', event);
            void this.close('gemini_error');
          },
          onclose: (event) => {
            if (!active.closed) {
              console.info(
                `[conversation] Gemini Live closed ${sessionId}; code=${event.code} reason=${event.reason || 'none'}`,
              );
              void this.close('gemini_closed', false);
            }
          },
        },
      });

      if (active.closed || this.active !== active) {
        liveSession.close();
        return;
      }
      active.liveSession = liveSession;

      await this.options.piCommandSink.publish({
        schema_version: '1.0',
        command_id: crypto.randomUUID(),
        action: 'start_conversation',
        session_id: sessionId,
        expires_at: expiresAt,
      });
      await this.publishControl(active, 'listening');
      console.info(
        `[conversation] listening for ${sourceEventId} in session ${sessionId}`,
      );
    } catch (error) {
      if (this.active === active) {
        await this.close('startup_error');
      }
      throw error;
    }
  }

  relayHomeownerMessage(sourceEventId: string, message: string): boolean {
    const active = this.active;
    if (
      !active ||
      active.closed ||
      !active.liveSession ||
      active.sourceEventId !== sourceEventId
    ) {
      console.info(`[conversation] homeowner message unavailable for ${sourceEventId}`);
      return false;
    }

    active.liveSession.sendRealtimeInput({
      text: [
        'This is a trusted homeowner instruction, not visitor speech.',
        'Say the following message aloud briefly and naturally.',
        `Homeowner message: ${message}`,
      ].join('\n'),
    });
    console.info(`[conversation] homeowner message delivered to ${active.sessionId}`);
    return true;
  }

  async closeForHomeowner(sourceEventId: string): Promise<boolean> {
    if (this.active?.sourceEventId !== sourceEventId) {
      return false;
    }
    await this.close('homeowner_ended');
    return true;
  }

  async closeForSource(sourceEventId: string): Promise<void> {
    if (this.active?.sourceEventId === sourceEventId) {
      await this.close('person_left');
    }
  }

  async close(reason: string, closeLive = true): Promise<void> {
    const active = this.active;
    if (!active || active.closed) {
      return;
    }
    active.closed = true;
    clearTimeout(active.timeout);
    this.active = undefined;

    await Promise.allSettled([
      this.publishControl(active, 'closed', reason),
      this.options.piCommandSink.publish({
        schema_version: '1.0',
        command_id: crypto.randomUUID(),
        action: 'stop_conversation',
        session_id: active.sessionId,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      }),
    ]);
    if (closeLive) {
      active.liveSession?.close();
    }
    console.info(
      `[conversation] closed ${active.sessionId}; reason=${reason}`,
    );
  }

  async stop(): Promise<void> {
    await this.close('shutdown');
    const client = this.mqttClient;
    this.mqttClient = undefined;
    if (client) {
      await client.endAsync();
    }
  }

  private forwardMicrophoneAudio(incomingTopic: string, payload: Buffer): void {
    const active = this.active;
    if (
      !active ||
      active.closed ||
      !active.liveSession ||
      active.speaking ||
      incomingTopic !== topic(this.options.inputTopicPrefix, active.sessionId)
    ) {
      return;
    }
    if (payload.length === 0 || payload.length > 32_000) {
      return;
    }

    try {
      active.liveSession.sendRealtimeInput({
        audio: {
          data: payload.toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    } catch (error) {
      console.error('[conversation] microphone forwarding failed', error);
      void this.close('input_error');
    }
  }

  private async handleLiveMessage(
    active: ActiveConversation,
    message: LiveServerMessage,
  ): Promise<void> {
    if (active.closed || this.active !== active) {
      return;
    }

    const parts = message.serverContent?.modelTurn?.parts ?? [];
    for (const part of parts) {
      const audio = part.inlineData?.data;
      if (!audio) {
        continue;
      }
      if (!active.speaking) {
        active.speaking = true;
        await this.publishControl(active, 'speaking');
      }
      await this.publishBinary(
        topic(this.options.outputTopicPrefix, active.sessionId),
        Buffer.from(audio, 'base64'),
      );
    }

    if (message.serverContent?.turnComplete) {
      active.speaking = false;
      await this.publishControl(active, 'listening');
    }
  }

  private async publishBinary(destination: string, payload: Buffer): Promise<void> {
    if (!this.mqttClient?.connected) {
      throw new Error('Conversation MQTT bridge disconnected.');
    }
    await this.mqttClient.publishAsync(destination, payload, {
      qos: 0,
      retain: false,
    });
  }

  private async publishControl(
    active: ActiveConversation,
    state: 'listening' | 'speaking' | 'closed',
    reason?: string,
  ): Promise<void> {
    const payload = Buffer.from(
      JSON.stringify({
        schema_version: '1.0',
        session_id: active.sessionId,
        state,
        reason,
      }),
    );
    await this.publishBinary(
      topic(this.options.controlTopicPrefix, active.sessionId),
      payload,
    );
  }
}
