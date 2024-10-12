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

interface InputTextContentType {
  type: 'input_text';
  text: string;
}

interface InputAudioContentType {
  type: 'input_audio';
  audio: string;
  audio_format?: {
    sample_rate: number;
    channel_count: number;
    bits_per_sample: number;
  };
}

function sendUserMessageContent(
  realtimeClient: RealtimeClient,
  content: Array<InputTextContentType | InputAudioContentType> = []
) {
  if (content.length) {
    (realtimeClient as any).realtime.send('conversation.item.create', {
      item: {
        type: 'message',
        role: 'user',
        content,
      },
    });
  }

  realtimeClient.createResponse();
  return true;
}



app.post("/speech-to-speech", async (req: Request<{}, {}, SpeechToSpeechRequest>, res: Response) => {
  const { audio, threadId, assistantId } = req.body;
  console.log("Request received:", { threadId, assistantId, audioLength: audio?.length });
  console.log("Audio input:", audio);

  if (!audio || !threadId || !assistantId) {
    return res.status(400).json({ error: "Audio, thread ID, and assistant ID are required" });
  }

  if (audio.length < 100) {  // Arbitrary threshold for a very short audio input
    console.warn("Warning: Audio input is suspiciously short. It may not be properly encoded.");
  }

  const realtimeClient = new RealtimeClient({ apiKey: API_TOKENS.OPENAI });

  try {
    console.log("Updating session parameters...");
    realtimeClient.updateSession({
      instructions: 'You are processing audio content. You will transcribe the audio or respond based on its content without identifying speakers.',
      voice: 'alloy',
      turn_detection: { type: 'server_vad' },
      input_audio_transcription: { model: 'whisper-1' },
    });

    console.log("Connecting to Realtime API...");
    await realtimeClient.connect();
    console.log("Connected to Realtime API");

    // Attempt to decode the base64 string
    let audioBuffer: Buffer;
    try {
      audioBuffer = Buffer.from(audio, 'base64');
      console.log("Decoded audio buffer length:", audioBuffer.byteLength);
    } catch (decodeError) {
      console.error("Failed to decode base64 audio:", decodeError);
      return res.status(400).json({ error: "Invalid audio encoding" });
    }

    if (audioBuffer.byteLength === 0) {
      console.error("Decoded audio buffer is empty");
      return res.status(400).json({ error: "Empty audio content" });
    }

    console.log("Sending audio to Realtime API...");
    
    sendUserMessageContent(realtimeClient, [{
      type: 'input_text',
      text: 'my name is christopher',  // Send the original base64 audio
    }]);

    sendUserMessageContent(realtimeClient, [{
      type: 'input_audio',
      audio: audio,  // Send the original base64 audio
      audio_format: {
        sample_rate: 16000,
        channel_count: 1,
        bits_per_sample: 16
      }
    }]);

    let transcriptionReceived = false;

    realtimeClient.on('conversation.updated', (event: any) => {
      console.log("Conversation updated:", event.item);
      if (event.item.role === 'assistant') {
        const { transcript, audio } = event.item.formatted;
        if (transcript && !transcriptionReceived) {
          console.log("Transcription of input audio:", transcript);
          transcriptionReceived = true;
        }
        if (event.item.status === 'completed' && audio) {
          sendAudioToClient(res, audio);
        }
      }
    });

    realtimeClient.on('error', (error: any) => {
      console.error("Realtime API error:", error);
      if (!res.writableEnded) {
        res.status(500).json({ error: "Error processing audio" });
      }
    });

    // Wait for the response to complete or timeout
    await Promise.race([
      new Promise((resolve) => realtimeClient.on('speech.completed', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 30000))
    ]);

    console.log("Speech-to-speech process completed");

    if (!transcriptionReceived) {
      console.warn("Warning: No transcription was received from the Realtime API");
    }

    req.on('close', () => {
      console.log("Client disconnected");
      realtimeClient.disconnect();
    });

  } catch (error) {
    console.error('Error in speech-to-speech:', error);
    realtimeClient.disconnect();
    if (!res.writableEnded) {
      res.status(500).json({ error: "Failed to process speech-to-speech request" });
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