// src/server.ts
import express, { Request, Response, NextFunction } from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import sharp from 'sharp';

dotenv.config();


const app = express();
const port = process.env.PORT || 3000;

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

// Middleware for basic authentication
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    if (token === process.env.EXTENSION_SECRET) {
      next();
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(401);
  }
};


app.get("/fetch-image", async (req: Request, res: Response) => {
    const imageUrl = req.query.url as string;
    console.log("imageUrl", imageUrl);

    if (!imageUrl) {
      return res.status(400).json({ error: "Image URL not provided" });
    }

    try {
      // Fetch the image
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
      }

      // Get the image buffer
      const imageBuffer = await imageResponse.arrayBuffer();

      // Compress the image
      const compressedImageBuffer = await sharp(Buffer.from(imageBuffer))
        .resize(300) // Resize to max width of 800px (adjust as needed)
        .jpeg({ quality: 50 }) // Convert to JPEG with 80% quality
        .toBuffer();

      // Convert the compressed image to a base64 string
      const base64 = compressedImageBuffer.toString('base64');

      res.json({ base64: `data:image/jpeg;base64,${base64}` });
    } catch (error) {
      console.error("Error processing image:", error);
      // Inform the client to fetch the image directly
      res.status(404).json({ clientFetch: true, message: "Image not found or couldn't be processed" });
    }
  });

  app.post("/process-simple-vision-api", authenticate, async (req: Request, res: Response) => {
    try {
      const { base64Image, promptText, currentLanguage, modelSelected, customPrompt } = req.body;
      
      // Get the user-specific API keys from the request headers
      const openAIKey = req.header('X-OpenAI-API-Key') || API_TOKENS.OPENAI;
      const anthropicKey = req.header('X-Claude-API-Key') || API_TOKENS.ANTHROPIC;
  
      const basePrompt = currentLanguage === 'sv'
        ? "Utforma en alt-text för en bild genom att ge en koncis och relevant beskrivning som matchar bilden innehåll och syfte. Fokusera på att vara kortfattad, vanligtvis räcker en eller två meningar. Undvik redundant information som redan finns i den medföljande texten. Om det är relevant, specificera om bilden är ett foto, en illustration, eller en annan bildtyp. Justera beskrivningen efter bilden användning och sammanhang, och undvik att använda fraser som \"bild av\" eller \"foto av\". Avsluta alt-texten med en punkt för en bättre läsupplevelse och hoppa över titelattributet för bättre tillgänglighet och användarupplevelse. Håll det kort och koncist och använd enkel svenska."
        : "Create an alt text for an image by providing a concise and relevant description that matches the image's content and purpose. Focus on being brief, typically one or two sentences suffice. Avoid redundant information already present in the accompanying text. If relevant, specify whether the image is a photo, illustration, or another image type. Adjust the description based on the image's use and context, and avoid using phrases like \"image of\" or \"photo of\". End the alt text with a period for better readability and skip the title attribute for improved accessibility and user experience. Keep it short and concise and use simple English.";
  
      const promptToUse = customPrompt || basePrompt;

      let response;
      let data;
  
      if (modelSelected === "gpt-4o-mini" || modelSelected === undefined) {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openAIKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: promptToUse + promptText },
                  { type: "image_url", image_url: { url: base64Image } }
                ]
              }
            ],
            temperature: 0.5,
            max_tokens: 3000,
          })
        });
  
        data = await response.json();
  
        if (data.choices && data.choices.length > 0) {
          res.json({ message: data.choices[0].message.content.trim() });
        } else {
          throw new Error("No response from OpenAI API");
        }
      } else if (modelSelected === "claude-sonnet") {

        // First, clean the base64Image by removing the data URL prefix
        const cleanedBase64Image = base64Image.replace(/^data:image\/\w+;base64,/, '');

        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': anthropicKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            max_tokens: 3000,
            messages: [
                { 
                  role: 'user', 
                  content: [
                    { type: "text", text: promptToUse + promptText },
                    { 
                      type: "image", 
                      source: { 
                        type: "base64", 
                        media_type: "image/jpeg", // or "image/png", etc.
                        data: cleanedBase64Image
                      } 
                    }
                  ]
                }
              ],
            model: 'claude-3-5-sonnet-20240620',
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`Anthropic API error: ${errorData.error.message}`);
        }
  
        data = await response.json();
        res.json({ message: data.content[0].text.trim() });
      } else {
        throw new Error("Invalid model specified");
      }
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: error });
    }
  });


  app.post("/send-message", authenticate, async (req: Request, res: Response) => {
    try {
      const { base64Image, promptText, currentLanguage, modelSelected, customPrompt } = req.body;
      
      // Get the user-specific API keys from the request headers
      const openAIKey = req.header('X-OpenAI-API-Key') || API_TOKENS.OPENAI;
      const anthropicKey = req.header('X-Claude-API-Key') || API_TOKENS.ANTHROPIC;
  
      const basePrompt = currentLanguage === 'sv'
        ? "Du är en professionell assistent som hjälper till att skapa bra och relevanta beskrivningar för bilder. Du är snabb och effektiv och kan skapa beskrivningar på bara några sekunder. Max: 200 tecken."
        : "You are a professional assistant that helps create good and relevant descriptions for images. You are fast and efficient and can create descriptions in just a few seconds. Max: 200 characters.";

      const promptToUse = basePrompt + customPrompt;

      let response;
      let data;
  
      if (modelSelected === "gpt-4o-mini" || modelSelected === undefined) {
        
        const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: "text", text: basePrompt + promptText }
        ];

        if (base64Image) {
          content.push({ type: "image_url", image_url: { url: base64Image } });
        }

        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openAIKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content: content
              }
            ],
            temperature: 0.5,
            max_tokens: 3000,
          })
        });
  
        data = await response.json();
  
        if (data.choices && data.choices.length > 0) {
          res.json({ message: data.choices[0].message.content.trim() });
        } else {
          throw new Error("No response from OpenAI API");
        }
      } else if (modelSelected === "claude-sonnet") {

        // First, clean the base64Image by removing the data URL prefix
        const cleanedBase64Image = base64Image.replace(/^data:image\/\w+;base64,/, '');

        const messageContent: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [
          { type: "text", text: promptToUse + promptText }
        ];
  
        if (cleanedBase64Image) {
          messageContent.push({ 
            type: "image", 
            source: { 
              type: "base64", 
              media_type: "image/jpeg", // or "image/png", etc.
              data: cleanedBase64Image
            } 
          });
        }
        
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': anthropicKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            max_tokens: 3000,
            messages: [
                { 
                  role: 'user', 
                  content: messageContent
                }
              ],
            model: 'claude-3-5-sonnet-20240620',
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`Anthropic API error: ${errorData.error.message}`);
        }
  
        data = await response.json();
        res.json({ message: data.content[0].text.trim() });
      } else {
        throw new Error("Invalid model specified");
      }
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: error });
    }
  });

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});