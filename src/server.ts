// src/server.ts
import express, { Request, Response, NextFunction } from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { Readable } from 'stream';

dotenv.config();

// Define types for events
interface ConversationEvent {
  item: {
    role: string;
  };
  delta?: {
    content?: string;
  };
}

interface SpeechEvent {
  delta: {
    audio: Buffer;
  };
}


const app = express();
const port = process.env.PORT || 3001;

// Your API tokens stored securely on the server
interface ApiTokens {
  OPENAI: string;
  ANTHROPIC: string;
  ELEVENLABS: string;
}

const API_TOKENS: ApiTokens = {
  OPENAI: process.env.OPENAI_API_KEY || '',
  ANTHROPIC: process.env.ANTHROPIC_API_KEY || '',
  ELEVENLABS: process.env.ELEVENLABS_API_KEY || ''
};

app.use(express.json());

// Enable CORS for all routes
app.use(cors());

// New route for speech-to-speech using Realtime API
app.post("/speech-to-speech", async (req: Request, res: Response) => {
  try {
    const { audio, threadId, assistantId } = req.body;
    console.log("Request body:", { threadId, assistantId, audioLength: audio?.length });


    if (!audio || !threadId || !assistantId) {
      return res.status(400).json({ error: "Audio, thread ID, and assistant ID are required" });
    }

    const realtimeClient = new RealtimeClient({ apiKey: API_TOKENS.OPENAI });
    console.log(realtimeClient);

    // Set up session parameters
    realtimeClient.updateSession({
      instructions: 'You are a helpful assistant.',
      voice: 'alloy',
      turn_detection: { type: 'server_vad' },
      input_audio_transcription: { model: 'whisper-1' }
    });

    // Connect to Realtime API
    await realtimeClient.connect();

    // Convert base64 audio to ArrayBuffer
    const audioBuffer = Buffer.from(audio, 'base64');

    // Send audio to Realtime API
    realtimeClient.appendInputAudio(new Int16Array(audioBuffer.buffer));
    realtimeClient.createResponse();

    // Set up a readable stream to send the response
    const stream = new Readable({
      read() {}
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');

    realtimeClient.on('conversation.updated', (event: ConversationEvent) => {
      const { item, delta } = event;
      if (item.role === 'assistant' && delta?.content) {
        stream.push(delta.content);
      }
    });

    realtimeClient.on('speech.in_progress', (event: SpeechEvent) => {
      stream.push(event.delta.audio);
    });

    realtimeClient.on('speech.completed', () => {
      stream.push(null);
    });

    realtimeClient.on('error', (error: Error) => {
      console.error('Realtime API error:', error);
      stream.destroy(error);
    });

    // Pipe the stream to the response
    stream.pipe(res);

    // Handle client disconnect
    req.on('close', () => {
      realtimeClient.disconnect();
      stream.destroy();
    });

  } catch (error) {
    console.error('Error in speech-to-speech:', error);
    res.status(500).json({ error: "Failed to process speech-to-speech request" });
  }
});


app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export {};  // Add this line at the end of the file