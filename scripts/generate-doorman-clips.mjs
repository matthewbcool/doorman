import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {GoogleGenAI} from '@google/genai';

const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global';
const outputDirectory = process.env.DOORMAN_TTS_OUTPUT_DIRECTORY?.trim() || '/output';
const model = process.env.DOORMAN_TTS_MODEL?.trim() || 'gemini-3.1-flash-tts-preview';
const voice = process.env.DOORMAN_TTS_VOICE?.trim() || 'Kore';

if (!project) {
  throw new Error('GOOGLE_CLOUD_PROJECT is required.');
}

const clips = [
  {
    id: 'greeting',
    prompt:
      "Speak warmly, clearly, and briefly as a transparent front-door AI concierge: Hi. I'm the home's AI assistant. How can I help with your visit?",
  },
  {
    id: 'kitty_greeting',
    prompt:
      "Speak warmly, playfully, and briefly in a friendly male voice: Who's a good kitty? Hi, kitty cat!",
  },
  {
    id: 'thank_driver',
    prompt:
      'Speak warmly and efficiently to a delivery person who may already be leaving: Thanks so much. Have a great day!',
  },
  {
    id: 'please_wait',
    prompt:
      "Speak calmly and reassuringly to a visitor: One moment, please. I'll let them know you're here.",
  },
  {
    id: 'no_soliciting',
    prompt:
      "Speak politely, firmly, and briefly: Thanks for stopping by. The household isn't accepting solicitations, but I hope you have a good day.",
  },
];

const requestedClip = process.env.DOORMAN_TTS_CLIP?.trim();
const selectedClips = requestedClip
  ? clips.filter((clip) => clip.id === requestedClip)
  : clips;
if (selectedClips.length === 0) {
  throw new Error(`Unknown DOORMAN_TTS_CLIP: ${requestedClip}`);
}

function pcmToWave(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function audioFromResponse(response) {
  const inlineData = response.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.data,
  )?.inlineData;
  if (!inlineData?.data) {
    throw new Error('Gemini returned no inline audio data.');
  }

  const rateMatch = /rate=(\d+)/i.exec(inlineData.mimeType || '');
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  return {
    pcm: Buffer.from(inlineData.data, 'base64'),
    sampleRate,
    mimeType: inlineData.mimeType || 'audio/L16;rate=24000',
  };
}

const client = new GoogleGenAI({
  vertexai: true,
  project,
  location,
});

await mkdir(outputDirectory, {recursive: true});

for (const clip of selectedClips) {
  const response = await client.models.generateContent({
    model,
    contents: [{role: 'user', parts: [{text: clip.prompt}]}],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {voiceName: voice},
        },
      },
    },
  });

  const {pcm, sampleRate, mimeType} = audioFromResponse(response);
  const outputPath = path.join(outputDirectory, `${clip.id}.wav`);
  await writeFile(outputPath, pcmToWave(pcm, sampleRate));
  console.info(
    JSON.stringify({clip_id: clip.id, output: outputPath, model, voice, sample_rate: sampleRate, source_mime_type: mimeType}),
  );
}
