// /.netlify/functions/data — storage cloud della cantina su Netlify Blobs.
//
// Il cloud è la fonte di verità. Ogni salvataggio porta con sé la revisione
// (baseRev) su cui il client ha lavorato: se nel frattempo un altro dispositivo
// ha salvato, il server risponde 409 con i dati correnti e il client li fonde.
// Così nessun dispositivo può sovrascrivere alla cieca il lavoro di un altro.
//
// Rete di sicurezza lato server:
//  - rifiuta un salvataggio che ha MENO vini del cloud (le eliminazioni sono
//    "tombstone", quindi la lista non deve mai accorciarsi)
//  - al primo salvataggio di ogni giorno conserva una copia della versione
//    precedente (chiave backup-AAAA-MM-GG)

import { getStore } from '@netlify/blobs';

const KEY = 'cellar';

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
  if (!pinOk(req)) return json(401, { error: 'PIN non valido' });

  const store = getStore({ name: 'mycave', consistency: 'strong' });

  if (req.method === 'GET') {
    const current = await store.get(KEY, { type: 'json' });
    return json(200, { data: current || null, pinRequired: Boolean(process.env.MYCAVE_PIN) });
  }

  if (req.method === 'PUT') {
    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'JSON non valido' }); }

    const incoming = body && body.state;
    const baseRev = Number(body && body.baseRev) || 0;
    if (!incoming || !Array.isArray(incoming.wines)) {
      return json(400, { error: 'Formato dati non valido' });
    }

    const existing = await store.getWithMetadata(KEY, { type: 'json' });
    const current = existing ? existing.data : null;

    if (current) {
      if (current.rev !== baseRev) {
        return json(409, { conflict: true, data: current });
      }
      if (incoming.wines.length < current.wines.length) {
        return json(422, { error: 'Salvataggio rifiutato: avrebbe fatto sparire dei vini', data: current });
      }
    } else if (baseRev !== 0) {
      return json(409, { conflict: true, data: null });
    }

    const next = {
      wines: incoming.wines,
      rev: (current ? current.rev : 0) + 1,
      savedAt: new Date().toISOString()
    };

    // Scrittura condizionale: fallisce se qualcuno ha scritto fra la lettura e ora.
    const result = existing
      ? await store.setJSON(KEY, next, { onlyIfMatch: existing.etag })
      : await store.setJSON(KEY, next, { onlyIfNew: true });

    if (result && result.modified === false) {
      const fresh = await store.get(KEY, { type: 'json' });
      return json(409, { conflict: true, data: fresh || null });
    }

    if (current) {
      const day = new Date().toISOString().slice(0, 10);
      try { await store.setJSON(`backup-${day}`, current, { onlyIfNew: true }); } catch { /* il backup è best-effort */ }
    }

    return json(200, { ok: true, rev: next.rev });
  }

  return json(405, { error: 'Metodo non consentito' });
};
