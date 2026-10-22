declare module 'node-webpmux' {
  export interface WebpImage {
    exif: Buffer | null;
    load(source: Buffer | string): Promise<void>;
    save(path: null): Promise<Buffer>;
    save(path: string): Promise<void>;
  }
  const webpmux: {
    Image: new () => WebpImage;
  };
  export default webpmux;
}
