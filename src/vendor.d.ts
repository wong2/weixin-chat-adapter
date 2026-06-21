declare module "qrcode-terminal" {
  const qrcode: {
    generate(input: string, options?: { small?: boolean }, callback?: (output: string) => void): void;
  };
  export default qrcode;
}

declare module "silk-wasm" {
  export function decode(
    input: Uint8Array | Buffer,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
}
