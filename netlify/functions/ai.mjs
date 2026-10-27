// /.netlify/functions/ai — proxy server-side verso l'API Anthropic.
// La chiave resta in ANTHROPIC_API_KEY su Netlify e non arriva mai al client.
// Modalità (campo "mode"): describe | sommelier | pair | recognize

const MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_VERSION = '2023-06-01';

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

function pinOk(req) {
  const expected = process.env.MYCAVE_PIN;
  if (!expected) return true;
  return req.headers.get('x-mycave-pin') === expected;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Metodo non consentito' });
  if (!pinOk(req)) return json(401, { error: 'PIN non valido' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: 'ANTHROPIC_API_KEY non configurata su Netlify' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'JSON non valido' }); }
  const { mode, payload = {} } = body;

  let system, messages, maxTokens;

  switch (mode) {
    case 'describe':
      system = 'Sei un sommelier esperto. Scrivi descrizioni evocative ma concrete, in italiano, senza aggettivi vuoti. Massimo 90 parole. Non inventare dati che non ti sono stati forniti (vitigni, gradazione, produttore).';
      messages = [{ role: 'user', content: `Scrivi una breve descrizione da scheda cantina per questo vino:\n${JSON.stringify(payload.wine, null, 2)}` }];
      maxTokens = 400;
      break;

    case 'sommelier': {
      system = 'Sei il sommelier personale di questa cantina privata. Rispondi in italiano, in modo diretto e concreto. Se ti viene chiesto un consiglio, motiva sempre la scelta. Se non sei sicuro di un dato, dillo.';
      const ctx = payload.wine
        ? `Il vino in questione:\n${JSON.stringify(payload.wine, null, 2)}\n\n`
        : payload.cellar
        ? `Inventario cantina disponibile:\n${JSON.stringify(payload.cellar, null, 2)}\n\n`
        : '';
      messages = [{ role: 'user', content: `${ctx}Domanda: ${payload.question}` }];
      maxTokens = 600;
      break;
    }

    case 'pair':
      system = 'Sei un sommelier che abbina vini a piatti usando SOLO i vini in cantina che ti vengono forniti (usa gli id forniti, mai inventarne). Rispondi in italiano. Suggerisci 2-3 vini in ordine di preferenza, motivando ogni scelta in una riga. Dai priorità ai vini con priorità "alta" (da bere presto) quando l\'abbinamento regge comunque bene, per favorire la rotazione. Rispondi con JSON puro, senza markdown: {"suggestions":[{"id":"...","reason":"..."}]}';
      messages = [{ role: 'user', content: `Piatto: ${payload.dish}\n\nCantina disponibile:\n${JSON.stringify(payload.cellar)}` }];
      maxTokens = 600;
      break;

    case 'recognize': {
      system = 'Estrai i dati di un vino da una o più foto di etichetta. Rispondi con JSON puro, senza markdown, con questo schema (null per i campi non leggibili, mai inventare): {"name":"","producer":"","label":"","year":null,"region":"","type":"","alcohol":"","notes":""}. In "region" usa la regione italiana in minuscolo (es. toscana). In "notes" metti dettagli utili letti in etichetta (vitigni, zona, gradazione, indicazioni).';
      const images = (payload.images || []).slice(0, 2).map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data }
      }));
      if (!images.length) return json(400, { error: 'Nessuna immagine ricevuta' });
      messages = [{ role: 'user', content: [...images, { type: 'text', text: 'Leggi questa etichetta e restituisci i dati nello schema richiesto.' }] }];
      maxTokens = 600;
      break;
    }

    default:
      return json(400, { error: `mode sconosciuta: ${mode}` });
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
    });
    if (!res.ok) {
      const detail = await res.text();
      return json(res.status === 401 ? 502 : res.status, { error: 'Errore API Anthropic', detail: detail.slice(0, 500) });
    }
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return json(200, { text, model: MODEL });
  } catch (err) {
    return json(500, { error: err.message || 'Errore interno' });
  }
};
