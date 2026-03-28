// Encoder wraps @xenova/transformers pipeline
// We use dynamic import to allow the package to be optional at build time

let pipeline: ((text: string | string[]) => Promise<{ data: Float32Array }[]>) | null = null;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

async function getPipeline() {
  if (!pipeline) {
    try {
      const { pipeline: createPipeline } = await import('@xenova/transformers');
      const p = await createPipeline('feature-extraction', MODEL_ID, {
        quantized: true,
      });
      pipeline = async (text: string | string[]) => {
        const output = await p(text, { pooling: 'mean', normalize: true });
        // Handle both single and batch
        if (Array.isArray(text)) {
          return output;
        }
        return [output];
      };
    } catch {
      // Fallback: deterministic hash-based pseudo-embeddings for environments without transformers
      pipeline = async (text: string | string[]) => {
        const texts = Array.isArray(text) ? text : [text];
        return texts.map(t => ({ data: hashEmbed(t, 384) }));
      };
    }
  }
  return pipeline;
}

/** Simple deterministic pseudo-embedding for fallback (no ML dependency). */
function hashEmbed(text: string, dims: number): Float32Array {
  const vec = new Float32Array(dims);
  for (let i = 0; i < text.length; i++) {
    const idx = (text.charCodeAt(i) * 2654435761) % dims;
    vec[idx] += Math.sin(i * 0.1);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}

export async function encode(text: string): Promise<Float32Array> {
  const p = await getPipeline();
  const [output] = await p(text);
  return output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
}

export async function encodeBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const p = await getPipeline();
  const outputs = await p(texts);
  return outputs.map(o => o.data instanceof Float32Array ? o.data : new Float32Array(o.data));
}

export const EMBEDDING_DIMS = 384;
