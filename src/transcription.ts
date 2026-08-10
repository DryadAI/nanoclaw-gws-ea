import fs from 'fs';
import { logger } from './logger.js';
import { ANTHROPIC_BASE_URL } from './config.js';

/**
 * Transcribe an audio file using a remote OpenAI-compatible API.
 * Uses the proxy configured in .env (ANTHROPIC_BASE_URL) which points to Bifrost.
 */
export async function transcribe(audioPath: string): Promise<string | null> {
  try {
    const fileBuffer = fs.readFileSync(audioPath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), 'audio.wav');
    formData.append('model', 'ollama/karanchopda333/whisper:latest');

    // Use the same proxy base URL we use for LLM
    const baseUrl =
      ANTHROPIC_BASE_URL?.replace(/\/messages$/, '') ||
      'http://host.docker.internal:4000/v1';

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ollama',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as { text: string };
    const text = result.text.trim();
    if (!text) return null;

    logger.info(
      { chars: text.length },
      'Transcribed audio message via remote API',
    );
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ audioPath, error: message }, 'Remote transcription failed');
    return null;
  }
}
