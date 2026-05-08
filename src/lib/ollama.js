import 'dotenv/config';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function embed(text, model) {
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text.slice(0, 8000) }),
  });
  if (!r.ok) throw new Error(`Ollama embed failed: ${await r.text()}`);
  const data = await r.json();
  return data.embeddings[0];
}

export async function generate(model, prompt) {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!r.ok) throw new Error(`Ollama generate failed: ${await r.text()}`);
  const data = await r.json();
  return data.response;
}
