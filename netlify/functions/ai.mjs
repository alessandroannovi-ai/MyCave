// /.netlify/functions/ai — proxy server-side verso l'API Anthropic.
// La chiave resta in ANTHROPIC_API_KEY su Netlify e non arriva mai al client.
// Modalità (campo "mode"): describe | sommelier | pair | recognize (foto) | parse (testo o voce)

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

    case 'pair': {
      const dish = String(payload.dish || '').trim().slice(0, 400);
      const today = new Date().toISOString().slice(0, 10);
      system = `Sei un sommelier che sceglie vini usando SOLO i vini in cantina che ti vengono forniti (usa gli id forniti, mai inventarne). Oggi è il ${today}. Rispondi in italiano. ` +
        (dish
          ? 'Abbina i vini al piatto: suggerisci 2-3 vini in ordine di preferenza, motivando ogni scelta in una riga. '
          : 'Non è indicato alcun piatto: scegli le 2 bottiglie migliori da aprire stasera, in base a priorità, annata e finestra di consumo, motivando ogni scelta in una riga. ') +
        'Dai priorità ai vini con priorità "alta" (da bere presto) quando la scelta regge comunque bene, per favorire la rotazione. Rispondi con JSON puro, senza markdown: {"suggestions":[{"id":"...","reason":"..."}]}';
      messages = [{ role: 'user', content: `${dish ? `Piatto: ${dish}` : 'Nessun piatto indicato.'}\n\nCantina disponibile:\n${JSON.stringify(payload.cellar)}` }];
      maxTokens = 600;
      break;
    }

    case 'recognize':
    case 'parse': {
      const today = new Date().toISOString().slice(0, 10);
      const common = [
        `Oggi è il ${today}.`,
        'Rispondi SOLO con JSON puro, senza markdown, con questo schema esatto:',
        '{"name":"","producer":"","label":"","year":null,"region":"","type":"","alcohol":"","notes":"","qty":null,"price":null,"color":"","priority":"","prestige":"","temp":"","window":{"from":null,"to":null}}',
        'CAMPI LETTI O DETTI (name, producer, label, year, region, type, alcohol, notes, qty, price): usa null se non sono leggibili o non sono stati detti, mai inventare.',
        '- name: nome del vino come appare (es. "Chianti Classico"); producer: la cantina; label: linea o riserva se presente; year: annata come numero, null se NV o assente.',
        '- region: regione italiana in minuscolo (es. toscana), per vini esteri la regione o il paese in minuscolo; type: denominazione o tipologia.',
        '- notes: vitigni, zona e indicazioni utili, massimo 200 caratteri.',
        '- qty: numero intero di bottiglie solo se indicato, altrimenti null.',
        '- price: prezzo di UNA bottiglia in euro, come numero (es. 34.33), solo se indicato. Se il prezzo è dato per più bottiglie ("68 euro in tutto") dividi per qty. Altrimenti null.',
        'CAMPI STIMATI DA TE (color, priority, prestige, temp, window): rispondi sempre, anche se non sono scritti, usando la tua competenza.',
        '- color: esattamente uno tra rosso, bianco, bollicina. Le bollicine rosate vanno in bollicina; un rosato fermo va in rosso se la tinta è intensa, altrimenti in bianco.',
        '- prestige: esattamente uno tra quotidiano (vino da tutti i giorni), buono (buon vino di denominazione, produttore solido), pregiato (denominazione importante, produttore di livello, riserve, cru), icona (etichette da collezione, grandi nomi).',
        '- window: anni di inizio e fine della finestra di consumo ottimale, in base ad annata, tipologia e produttore; senza annata usa null.',
        '- priority: esattamente uno tra alta (oggi è già nella finestra ed è oltre metà o vicino alla fine: da bere presto), media (oggi è dentro la finestra ottimale), conservazione (oggi è prima della finestra o è un vino da lungo invecchiamento). Senza annata usa media.',
        '- temp: temperatura di servizio nel formato "16–18°C".'
      ];
      if (mode === 'recognize') {
        system = [
          'Sei un sommelier esperto. Ricevi una o più foto di un\'etichetta di vino (fronte e/o retro).',
          'L\'immagine può essere anche lo screenshot di un\'app o di un sito di vini (per esempio Vivino): in quel caso leggi i dati del vino mostrato e ignora voti e pulsanti; il prezzo vale solo se è chiaramente quello di una bottiglia.',
          ...common
        ].join('\n');
        const images = (payload.images || []).slice(0, 2).map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data }
        }));
        if (!images.length) return json(400, { error: 'Nessuna immagine ricevuta' });
        messages = [{ role: 'user', content: [...images, { type: 'text', text: 'Leggi questa etichetta e restituisci i dati nello schema richiesto.' }] }];
      } else {
        const text = String(payload.text || '').trim().slice(0, 800);
        if (!text) return json(400, { error: 'Nessun testo ricevuto' });
        system = [
          'Sei un sommelier esperto. Ricevi la descrizione, scritta o dettata a voce in italiano, di una bottiglia di vino da inserire in cantina.',
          'Il testo può contenere errori di trascrizione: correggi i nomi evidenti di vini, cantine e denominazioni usando la tua conoscenza, ma non aggiungere dati che non sono stati detti.',
          ...common
        ].join('\n');
        messages = [{ role: 'user', content: `Descrizione della bottiglia:\n${text}` }];
      }
      maxTokens = 800;
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
