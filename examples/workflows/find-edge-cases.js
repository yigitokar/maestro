export const meta = {
  name: 'find-edge-cases',
  description: 'İki tur üst üste yeni şey çıkmayana kadar edge case ara',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

// Spec Seviye 4, Örnek 2: loop-until-dry (bilinmeyen boyutlu keşif).
// args: { target: string }  ör. { "target": "src/journal.ts" }

const BUGS = { type: 'object', properties: { bugs: { type: 'array', items: {
  type: 'object', properties: { key: { type: 'string' }, desc: { type: 'string' } }, required: ['key', 'desc'] } } },
  required: ['bugs'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] }

const LENSES = ['boş girdi ve sınır değerler', 'eşzamanlılık ve sıra', 'hata yolları ve kısmi başarı']
const seen = new Set(), confirmed = []
let dry = 0, round = 0

while (dry < 2 && round < 6) {
  round++
  const found = (await parallel(LENSES.map((lens, i) => () =>
    agent(`${args.target} içinde edge case ara. Mercek: ${lens}. Tur ${round}. ` +
          `Daha önce bulunanlar (tekrar etme): ${[...seen].join(', ') || 'yok'}`,
      { label: `find:${i}:r${round}`, phase: 'Find', schema: BUGS }))))
    .filter(Boolean).flatMap(r => r.bugs)

  const fresh = found.filter(b => !seen.has(b.key))
  if (!fresh.length) { dry++; log(`tur ${round}: yeni yok (${dry}/2)`); continue }
  dry = 0
  fresh.forEach(b => seen.add(b.key))          // seen'e ekle, confirmed'e değil

  const judged = await parallel(fresh.map(b => () =>
    agent(`"${b.desc}" gerçek bir hata mı? Kodu oku, kanıt göster.`, { phase: 'Verify', schema: VERDICT })
      .then(v => v && v.real ? b : null)))
  confirmed.push(...judged.filter(Boolean))
  log(`tur ${round}: ${fresh.length} yeni, ${confirmed.length} doğrulanmış`)
}
if (round >= 6) log('tur tavanına ulaşıldı, kuyruk tam taranmadı')
return { confirmed, rounds: round }
