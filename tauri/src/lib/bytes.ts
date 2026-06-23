// Browser APIs like `fetch` bodies, `Blob` parts, and `decodeAudioData` require
// an ArrayBuffer-backed buffer. Since TypeScript 5.7, typed arrays are generic
// over their backing buffer (`Uint8Array<ArrayBufferLike>`), so a plain
// `Uint8Array` is no longer provably ArrayBuffer-backed at the type level — it
// could be SharedArrayBuffer-backed. This copies the view's bytes into a
// standalone ArrayBuffer, giving those APIs exactly what they require.
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  return ab;
}
