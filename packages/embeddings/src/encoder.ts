// Encoder wraps @xenova/transformers pipeline
// We use dynamic import to allow the package to be optional at build time

type EmbeddingData = Float32Array | ArrayLike<number>;
type EmbeddingOutput = { data: EmbeddingData };
type EmbeddingPipeline = (text: string | string[]) => Promise<EmbeddingOutput[]>;

let pipeline: EmbeddingPipeline | undefined;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

function isEmbeddingOutput(value: unknown): value is EmbeddingOutput {
  return typeof value === 'object' && value !== null && 'data' in value;
}

function normalizeOutputs(output: unknown): EmbeddingOutput[] {
  if (Array.isArray(output)) {
    return output.filter(isEmbeddingOutput);
  }

  if (isEmbeddingOutput(output)) {
    return [output];
  }

  return [];
}

async function getPipeline(): Promise<EmbeddingPipeline> {
  if (pipeline === undefined) {
    try {
      const { pipeline: createPipeline } = await import('@xenova/transformers');
      const p = await createPipeline('feature-extraction', MODEL_ID, {
        quantized: true,
      });
      pipeline = async (text: string | string[]) => {
        const output = await p(text, { pooling: 'mean', normalize: true });
        return normalizeOutputs(output);
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
    vec[idx] = (vec[idx] ?? 0) + Math.sin(i * 0.1);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const value = vec[i] ?? 0;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) {
    vec[i] = (vec[i] ?? 0) / norm;
  }
  return vec;
}

export async function encode(text: string): Promise<Float32Array> {
  const p = await getPipeline();
  const [output] = await p(text);
  if (!output) {
    throw new Error('Embedding pipeline returned no output');
  }
  return output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
}

export async function encodeBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const p = await getPipeline();
  const outputs = await p(texts);
  return outputs.map(o => o.data instanceof Float32Array ? o.data : new Float32Array(o.data));
}

export const EMBEDDING_DIMS = 384;
