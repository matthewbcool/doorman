import {GoogleAuth} from 'google-auth-library';

import {doormanLiveModel, doormanLiveVoice} from '../shared/live.js';

export interface LiveCredential {
  token: string;
  model: string;
  voice: string;
  expiresAt: string;
}

interface TokenBrokerResponse {
  token?: unknown;
  model?: unknown;
  voice?: unknown;
  expires_at?: unknown;
}

export class LiveTokenBrokerClient {
  private readonly auth = new GoogleAuth();
  private readonly audience: string;

  constructor(private readonly endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') {
      throw new Error('The Live token broker endpoint must use HTTPS.');
    }
    this.audience = url.origin;
  }

  async createCredential(): Promise<LiveCredential> {
    const client = await this.auth.getIdTokenClient(this.audience);
    const response = await client.request<TokenBrokerResponse>({
      url: this.endpoint,
      method: 'POST',
      timeout: 10_000,
      headers: {'content-type': 'application/json'},
      data: {},
    });
    const data = response.data;

    if (
      typeof data.token !== 'string' ||
      !data.token.startsWith('auth_tokens/')
    ) {
      throw new Error('The Live token broker returned an invalid token.');
    }
    if (data.model !== doormanLiveModel) {
      throw new Error('The Live token broker returned an unexpected model.');
    }
    if (data.voice !== doormanLiveVoice) {
      throw new Error('The Live token broker returned an unexpected voice.');
    }
    if (
      typeof data.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(data.expires_at))
    ) {
      throw new Error('The Live token broker returned an invalid expiration.');
    }

    return {
      token: data.token,
      model: data.model,
      voice: data.voice,
      expiresAt: data.expires_at,
    };
  }
}
