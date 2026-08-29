import {GoogleGenAI, Modality} from '@google/genai';
import express from 'express';

import {
  doormanLiveInstruction,
  doormanLiveModel,
  doormanLiveVoice,
} from '../shared/live.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const apiKey = requiredEnvironment('GEMINI_API_KEY');
const port = Number(process.env.PORT ?? 8080);
const gemini = new GoogleGenAI({
  apiKey,
  httpOptions: {apiVersion: 'v1beta'},
});
const app = express();

app.disable('x-powered-by');

app.get('/healthz', (_request, response) => {
  response.status(200).json({status: 'ok'});
});

app.post('/api/live/token', async (_request, response) => {
  const now = Date.now();
  const expireTime = new Date(now + 2 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now + 45_000).toISOString();

  try {
    const token = await gemini.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: doormanLiveModel,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {voiceName: doormanLiveVoice},
              },
            },
            systemInstruction: doormanLiveInstruction,
          },
        },
        lockAdditionalFields: [],
      },
    });
    if (!token.name) {
      throw new Error('Gemini returned an empty ephemeral token.');
    }

    response
      .set('cache-control', 'no-store')
      .status(200)
      .json({
        token: token.name,
        model: doormanLiveModel,
        voice: doormanLiveVoice,
        expires_at: expireTime,
      });
  } catch (error) {
    console.error('[token-broker] ephemeral token creation failed', error);
    response.status(502).json({error: 'token_creation_failed'});
  }
});

app.listen(port, () => {
  console.info(
    JSON.stringify({
      service: 'doorman-live-token-broker',
      port,
      model: doormanLiveModel,
      token_uses: 1,
    }),
  );
});
