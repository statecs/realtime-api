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
  console.log("Sending user message content to Realtime API");
  console.log("Content length:", content.length);
  
  if (content.length) {
    const audioContent = content.find(item => item.type === 'input_audio') as InputAudioContentType | undefined;
    if (audioContent) {
      console.log("Audio content found:");
      console.log("- Audio length:", audioContent.audio.length);
      console.log("- Audio format:", JSON.stringify(audioContent.audio_format));

    }

    try {
      (realtimeClient as any).realtime.send('conversation.item.create', {
        item: {
          type: 'message',
          role: 'user',
          content,
        },
      });
      console.log("Message sent successfully to Realtime API", content);
    } catch (error) {
      console.error("Error sending message to Realtime API:", error);
      throw error;
    }
  } else {
    console.warn("No content to send to Realtime API");
  }

  realtimeClient.createResponse();
  return true;
}

app.post("/speech-to-speech", async (req: Request<{}, {}, SpeechToSpeechRequest>, res: Response) => {
  const { audio, threadId, assistantId } = req.body;
  console.log("Request received:", { threadId, assistantId, audioLength: audio?.length });

  if (!audio || !threadId || !assistantId) {
    console.error("Missing required parameters");
    return res.status(400).json({ error: "Audio, thread ID, and assistant ID are required" });
  }

  if (!API_TOKENS.OPENAI) {
    console.error("OpenAI API key is missing");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const realtimeClient = new RealtimeClient({ apiKey: API_TOKENS.OPENAI });

  try {
    console.log("Updating session parameters...");
    realtimeClient.updateSession({
      instructions: 'You are processing audio content',
      voice: 'alloy',
      turn_detection: { type: 'server_vad' },
      input_audio_transcription: { model: 'whisper-1' },
    });

    console.log("Connecting to Realtime API...");
    await realtimeClient.connect();
    console.log("Connected to Realtime API");


    if (audio.length === 0) {
      console.error("Received audio is empty");
      return res.status(400).json({ error: "Empty audio content" });
    }

    console.log("Sending audio to Realtime API...");

    const decodedText = Buffer.from(audio, 'base64').toString('utf-8');
    
    try {

      sendUserMessageContent(realtimeClient, [{
        type: 'input_text',
        text: decodedText  // Send the original base64 audio
      }]);


    } catch (error) {
      console.error("Error in sendUserMessageContent:", error);
      return res.status(500).json({ error: "Failed to send audio to Realtime API" });
    }

    let transcriptionReceived = false;

    realtimeClient.on('conversation.updated', (event: any) => {
      if (event.item.role === 'assistant') {
        const { transcript, audio } = event.item.formatted;
        if (transcript && !transcriptionReceived) {
          console.log("Transcription of input audio:", transcript);
          transcriptionReceived = true;
        }
        if (event.item.status === 'completed' && audio) {
          console.log("Received completed audio response");
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
    try {
      await Promise.race([
        new Promise((resolve) => realtimeClient.on('speech.completed', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 30000))
      ]);
      console.log("Speech-to-speech process completed");
    } catch (error) {
      console.error("Error or timeout in speech-to-speech process:", error);
      if (!res.writableEnded) {
        res.status(500).json({ error: "Speech-to-speech process failed or timed out" });
      }
    }

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
        'Content-Type': 'audio/wav',
        'Transfer-Encoding': 'chunked'
      });
    }

    // Create a WAV file from the PCM data
    const wavData = {
      sampleRate: 16000,
      channelData: [audio]
    };

    const float32ChannelData = wavData.channelData.map(channel => 
      Float32Array.from(channel, x => x / 32768)
    );

    WavEncoder.encode({
      sampleRate: wavData.sampleRate,
      channelData: float32ChannelData
    }).then((buffer: ArrayBuffer) => {
      console.log("Sending encoded WAV audio to client, length:", buffer.byteLength);
      res.write(Buffer.from(buffer));
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