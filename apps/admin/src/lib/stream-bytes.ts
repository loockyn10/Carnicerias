/** Un PNG como respuesta en streaming (de a 256 KB): Vercel no aplica a las respuestas en streaming el tope de 4,5 MB del cuerpo. */
export function streamBytes(bytes: Uint8Array, chunkSize = 256 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }
  });
}
