// Type stubs for the editor's TS worker. Source: runtime docs/handlers.md "std:blob".
declare module "std:blob" {
  export type BlobBody = string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | Blob;
  export interface BlobMeta {
    size: number;
    contentType: string | null;
  }
  export interface BlobStore {
    put(key: string, body: BlobBody, options?: { contentType?: string }): Promise<void>;
    get(key: string): Promise<(BlobMeta & { body: ReadableStream<Uint8Array> }) | null>;
    head(key: string): Promise<BlobMeta | null>;
    delete(key: string): Promise<boolean>;
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
      objects: (BlobMeta & { key: string })[];
      cursor: string | null;
    }>;
  }
  export const blob: BlobStore;
}
