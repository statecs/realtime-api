import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { RealtimeClient } from '@openai/realtime-api-beta';
import WavEncoder from 'wav-encoder';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

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
app.use(cors());

interface SpeechToSpeechRequest {
  audio: string;
  threadId: string;
  assistantId: string;
}

app.post("/speech-to-speech", async (req: Request<{}, {}, SpeechToSpeechRequest>, res: Response) => {
  const { audio, threadId, assistantId } = req.body;
  console.log("Request received:", { threadId, assistantId, audioLength: audio?.length });

  if (!audio || !threadId || !assistantId) {
    return res.status(400).json({ error: "Audio, thread ID, and assistant ID are required" });
  }

  const realtimeClient = new RealtimeClient({ apiKey: API_TOKENS.OPENAI });
  let responseStarted = false;
  let eventReceived = false;
  let audioChunksReceived = 0;

  try {
    console.log("Updating session parameters...");
    realtimeClient.updateSession({
      instructions: 'You are a helpful assistant.',
      voice: 'alloy',
      turn_detection: { type: 'server_vad' },
      input_audio_transcription: { model: 'whisper-1' },
    });

    console.log("Connecting to Realtime API...");
    await realtimeClient.connect();
    console.log("Connected to Realtime API");

    realtimeClient.on('realtime.event', (event: any) => {
      console.log("Realtime event received:", JSON.stringify(event, null, 2));
      eventReceived = true;
    });

    realtimeClient.on('conversation.updated', (event: any) => {
      console.log("Conversation updated:", JSON.stringify(event, null, 2));
      const { item, delta } = event;
      if (item.role === 'assistant' && item.status === 'completed') {
        console.log("Assistant response completed:", item.formatted.transcript);
        if (item.formatted.audio && item.formatted.audio.length > 0) {
          console.log("Sending formatted audio to client, length:", item.formatted.audio.length);
          sendAudioToClient(res, item.formatted.audio);
        } else {
          console.log("No formatted audio received in conversation.updated event");
        }
      }
    });

    realtimeClient.on('speech.in_progress', (event: { delta: { audio: Int16Array } }) => {
      console.log("Received speech chunk, length:", event.delta.audio.length);
      audioChunksReceived++;
      sendAudioToClient(res, event.delta.audio);
    });

    realtimeClient.on('speech.completed', () => {
      console.log("Speech completed, total audio chunks received:", audioChunksReceived);
      if (!res.writableEnded) {
        res.end();
      }
    });

    const audioBuffer = Buffer.from(audio, 'base64');
    console.log("Appending audio input, length:", audioBuffer.length);
    realtimeClient.appendInputAudio(new Int16Array(audioBuffer.buffer));
    console.log("Audio input appended");

    console.log("Creating response...");
    realtimeClient.createResponse();
    console.log("Response creation initiated");

    req.on('close', () => {
      console.log("Client disconnected");
      realtimeClient.disconnect();
    });

  } catch (error) {
    console.error('Error in speech-to-speech:', error);
    realtimeClient.disconnect();
    if (!res.writableEnded) {
      if (!responseStarted) {
        res.status(500).json({ error: "Failed to process speech-to-speech request" });
      } else {
        res.end();
      }
    }
  }
});


function sendAudioToClient(res: Response, audio: Int16Array) {
  if (!res.writableEnded) {
    if (!res.headersSent) {
      console.log("Sending headers to client");
      res.writeHead(200, {
        'Content-Type': 'audio/wav', // Change to audio/wav
        'Transfer-Encoding': 'chunked'
      });
    }

    // Create a WAV file from the PCM data
    const wavData = {
      sampleRate: 16000, // Use the correct sample rate of your audio
      channelData: [audio] // mono or stereo, adjust accordingly
    };

    const float32ChannelData = wavData.channelData.map(channel => 
      Float32Array.from(channel, x => x / 32768)
    );

    WavEncoder.encode({
      sampleRate: wavData.sampleRate,
      channelData: float32ChannelData
    }).then((buffer: ArrayBuffer) => {
      console.log("Sending encoded WAV audio to client, length:", buffer.byteLength);
      res.write(Buffer.from(buffer)); // Send the encoded WAV audio to the client
      res.end();
    }).catch((error: Error) => {
      console.error("Error encoding WAV audio:", error);
      res.status(500).json({ error: "Failed to encode audio" });
    });
  } else {
    console.log("Cannot send audio: Response has already ended");
  }
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export {};