import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import WavEncoder from 'wav-encoder';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

const API_TOKENS = {
  OPENAI: process.env.OPENAI_API_KEY || '',
  ANTHROPIC: process.env.ANTHROPIC_API_KEY || '',
  ELEVENLABS: process.env.ELEVENLABS_API_KEY || ''
};

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/audio-stream' });

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected via WebSocket');

  let realtimeClient: RealtimeClient;

  // Promise that resolves when the RealtimeClient is connected
  const connectionReadyPromise = new Promise<void>((resolve, reject) => {
    (async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        ws.send(JSON.stringify({ error: 'OPENAI_API_KEY is not defined' }));
        ws.close();
        return reject(new Error('OPENAI_API_KEY is not defined'));
      }

      realtimeClient = new RealtimeClient({ apiKey });

      try {
        await realtimeClient.updateSession({
          instructions: 'You are a helpful assistant processing audio content.',
          voice: 'alloy',
          turn_detection: { type: 'server_vad' },
          input_audio_transcription: { model: 'whisper-1' },
          input_audio_config: { sampling_rate: 16000 },
        });

        // Add error handling
        realtimeClient.on('error', (error: any) => {
          console.error('Realtime API error:', error);
          ws.send(JSON.stringify({ error: 'Realtime API error occurred', details: error.message }));
        });

        await realtimeClient.connect();
        console.log('Connected to Realtime API');

        // Handle responses from Realtime API
        realtimeClient.on('conversation.updated', (event: any) => {
          console.log('Conversation updated event:', event);
          if (event.item.role === 'assistant') {
            const { transcript, audio } = event.item.formatted;
            if (transcript) {
              console.log('Transcription:', transcript);
            }
            if (audio) {
              sendAudioToClient(ws, audio);
            }
          }
        });

        resolve();
      } catch (error) {
        console.error('Error connecting to Realtime API:', error);
        if (error instanceof Error) {
            ws.send(JSON.stringify({ error: 'Failed to connect to Realtime API', details: error.message }));
        } else {
            ws.send(JSON.stringify({ error: 'Failed to connect to Realtime API', details: 'Unknown error' }));
        }
        ws.close();
        reject(error);
      }
    })();
  });

  ws.on('message', async (message: WebSocket.Data, isBinary: boolean) => {
    try {
      // Wait until the RealtimeClient is connected
      await connectionReadyPromise;

      let int16Data: Int16Array;

      // Process the incoming message
      if (Buffer.isBuffer(message)) {
        int16Data = new Int16Array(message.buffer, message.byteOffset, message.byteLength / Int16Array.BYTES_PER_ELEMENT);
        console.log('Received audio data from client:', int16Data.length, 'samples');

        // Ensure the data is in the expected format
        // If necessary, adjust or validate the audio data here

        // Append audio data to Realtime API
        console.log('Appending audio data to Realtime API');
        realtimeClient.appendInputAudio(int16Data);
      } else {
        console.error('Received data is not a Buffer');
        ws.send(JSON.stringify({ error: 'Expected binary data, received non-binary' }));
        return;
      }
    } catch (error) {
      console.error('Error in message handler:', error);
      ws.send(JSON.stringify({ 
        error: 'Error in message handler', 
        details: error instanceof Error ? error.message : String(error) 
      }));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    if (realtimeClient) {
      realtimeClient.disconnect();
    }
  });
});

function sendAudioToClient(ws: WebSocket, audio: Int16Array) {
  // Create a WAV file from the PCM data
  const wavData = {
    sampleRate: 16000,
    channelData: [audio],
  };

  const float32ChannelData = wavData.channelData.map((channel) =>
    Float32Array.from(channel, (x) => x / 32768)
  );

  WavEncoder.encode({
    sampleRate: wavData.sampleRate,
    channelData: float32ChannelData,
  })
    .then((buffer: ArrayBuffer) => {
      console.log('Sending encoded WAV audio to client');
      ws.send(Buffer.from(buffer));
    })
    .catch((error: Error) => {
      console.error('Error encoding WAV audio:', error);
      ws.send(JSON.stringify({ error: 'Failed to encode audio' }));
    });
}

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export {};
