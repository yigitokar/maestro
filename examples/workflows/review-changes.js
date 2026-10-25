export const meta = {
  name: 'review-changes',
  description: 'Diff\'i üç boyuttan incele, her bulguyu üç skeptikle oyla',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

// Spec Seviye 4, Örnek 1: bul → adversarial doğrula → sentezle.
// args: { diffRef: string }  ör. { "diffRef": "main...HEAD" }

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: {
      type: 'object',
      properties: {
        file: { type: 'string' }, line: { type: 'integer' },
        claim: { type: 'string' }, failure: { type: 'string' },
      },
      required: ['file', 'line', 'claim', 'failure'],
    } },
  },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

const DIFF = `Diff: ${args.diffRef}. Değişikliği "git diff ${args.diffRef}" ile oku, dokunulan dosyaların çevresini de oku.`
const DIMENSIONS = [
  { key: 'correctness', prompt: `${DIFF} Yalnızca mantık hatası ara: yanlış koşul, sınır değer, null/undefined, sıra, yanlış dönüş değeri.` },
  { key: 'security',    prompt: `${DIFF} Yalnızca güvenlik: enjeksiyon, yetki atlama, sır sızıntısı, güvenilmeyen girdinin doğrulanmaması.` },
  { key: 'data-loss',   prompt: `${DIFF} Veri kaybı ve geri alınamaz işlem: silme, üzerine yazma, migration, yarım kalan yazma.` },
]

const perDimension = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS }),
  async (found, d) => {
    if (!found) { log(`${d.key}: bulucu null döndü`); return [] }
    return parallel(found.findings.map(f => async () => {
      const votes = await parallel([0, 1, 2].map(i => () =>
        agent(`Bu iddiayı ÇÜRÜTMEYE çalış: ${f.claim} (${f.file}:${f.line}). Senaryo: ${f.failure}. ` +
              `Kodu oku. Emin değilsen refuted=true. Perspektif ${i}: ${['tekrar üretilebilirlik','niyet/edge case','mevcut testler'][i]}.`,
          { label: `verify:${f.file}:${f.line}#${i}`, phase: 'Verify', schema: VERDICT, effort: 'high' })))
      const alive = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
      return alive ? { ...f, dimension: d.key, votes } : null
    }))
  },
)

const confirmed = perDimension.filter(Boolean).flat().filter(Boolean)
log(`${confirmed.length} bulgu oylamayı geçti`)
if (!confirmed.length) return { findings: [] }

const summary = await agent(
  `Şu doğrulanmış bulguları ciddiyete göre sırala ve her birine tek cümle düzeltme öner:\n${JSON.stringify(confirmed)}`,
  { phase: 'Synthesize', schema: FINDINGS })
return summary
