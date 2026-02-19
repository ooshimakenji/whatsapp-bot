import sharp from 'sharp';
import { readBarcodesFromImageData, defaultZXingReadOptions } from '@sec-ant/zxing-wasm/reader';

/**
 * Tenta ler um código de barras de um buffer de imagem (JPEG/PNG/etc).
 * Retorna o primeiro número de 10 dígitos encontrado, ou null se não encontrar.
 *
 * Usa ZXing-C++ (WASM) com tryHarder + rotações para cobrir barcodes em qualquer ângulo.
 */
export async function tryReadBarcode(imageBuffer) {
  const pipelines = [
    // Tamanho original em 4 rotações — Code128 linear precisa de alinhamento horizontal/vertical
    () => sharp(imageBuffer),
    () => sharp(imageBuffer).rotate(90),
    () => sharp(imageBuffer).rotate(180),
    () => sharp(imageBuffer).rotate(270),
    // Normalize + sharpen (fotos escuras/desfocadas), nas 4 rotações
    () => sharp(imageBuffer).normalize().sharpen(),
    () => sharp(imageBuffer).normalize().sharpen().rotate(90),
  ];

  for (const buildPipeline of pipelines) {
    try {
      const { data, info } = await buildPipeline()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const imageData = {
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height,
      };

      const results = await readBarcodesFromImageData(imageData, {
        ...defaultZXingReadOptions,
        tryHarder: true,
      });

      for (const result of results) {
        const match = result.text?.match(/\b(\d{10})\b/);
        if (match) return match[1];
      }
    } catch {
      // Continua tentando próximo preprocessamento
    }
  }
  return null;
}
