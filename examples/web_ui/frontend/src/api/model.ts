import { client } from './client';
import type { ListEmbeddingModelResponse, ListModelResponse, ListTTSModelResponse } from './types';

export const modelApi = {
	list: (provider: string, credential_id?: string) =>
		client.get<ListModelResponse>(
			'/model/',
			credential_id ? { provider, credential_id } : { provider },
		),
};

export const ttsModelApi = {
	list: (provider: string, credential_id?: string) =>
		client.get<ListTTSModelResponse>(
			'/tts-model/',
			credential_id ? { provider, credential_id } : { provider },
		),
};

export const embeddingModelApi = {
	list: (provider: string, credential_id?: string) =>
		client.get<ListEmbeddingModelResponse>(
			'/embedding-model/',
			credential_id ? { provider, credential_id } : { provider },
		),
};
