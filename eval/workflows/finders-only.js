export const meta = {
  name: 'finders-only',
  description: 'C kolu: review-changes\'in üç bulucusu, skeptik ve sentez yok',
  phases: [{ title: 'Find' }],
  maxAgents: 3,
}

// Ablasyon kolu: B'nin (examples/workflows/review-changes.js) bulucu prompt'ları birebir, oylama yok.
// B ile farkı skeptiklerin, A ile farkı üç ayrı bakışın ne kattığını gösterir.
// args: { diffRef: string }

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

const DIFF = `Diff: ${args.diffRef}. Değişikliği "git diff ${args.diffRef}" ile oku, dokunulan dosyaların çevresini de oku.`
const DIMENSIONS = [
  { key: 'correctness', prompt: `${DIFF} Yalnızca mantık hatası ara: yanlış koşul, sınır değer, null/undefined, sıra, yanlış dönüş değeri.` },
  { key: 'security',    prompt: `${DIFF} Yalnızca güvenlik: enjeksiyon, yetki atlama, sır sızıntısı, güvenilmeyen girdinin doğrulanmaması.` },
  { key: 'data-loss',   prompt: `${DIFF} Veri kaybı ve geri alınamaz işlem: silme, üzerine yazma, migration, yarım kalan yazma.` },
]

const found = await parallel(DIMENSIONS.map(d => () =>
  agent(d.prompt, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS })))
const failed = found.filter(f => !f).length
if (failed) log(`${failed} bulucu null döndü`)

// Aynı dosya ve satırı iki bulucu bildirirse biri kalır.
const seen = new Set()
const findings = found.filter(Boolean).flatMap(f => f.findings).filter(f => {
  const k = `${f.file}:${f.line}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
return failed === DIMENSIONS.length ? { findings: [], failed: true } : { findings }
