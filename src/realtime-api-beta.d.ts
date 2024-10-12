declare module '@openai/realtime-api-beta' {
    export type EventHandlerCallbackType = (event: any) => void;
  
    export interface Item {
      // Define properties of item if known, otherwise use any
      [key: string]: any;
    }
  
    export class RealtimeClient {
      constructor(options: { apiKey: string });
      updateSession(options: any): void;
      connect(): Promise<void>;
      appendInputAudio(audio: Int16Array): void;
      createResponse(): void;
      on(eventName: string, callback: EventHandlerCallbackType): EventHandlerCallbackType;
      onNext(eventName: string, callback: EventHandlerCallbackType): EventHandlerCallbackType;
      off(eventName: string, callback?: EventHandlerCallbackType): true;
      offNext(eventName: string, callback?: EventHandlerCallbackType): true;
      disconnect(): void;
      processEvent(event: any, ...args: any[]): Item;
    }
  }