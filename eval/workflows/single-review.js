export const meta = {
  name: 'single-review',
  description: 'A kolu: aynı diff\'i tek ajan inceler',
  phases: [{ title: 'Review' }],
  maxAgents: 1,
}

// docs/eval.md bölüm 4, A kolu. B (eval/workflows/review-changes.js) ile aynı model, aynı salt-okur
// araçlar, aynı çıktı şeması; fark yalnızca orkestrasyondur. Prompt, B'nin üç bulucusunun baktığı her
// şeyi tek ajana verir.
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

// Yalnızca B'nin üç bulucu prompt'unun cümleleri, tek istemde: A'ya B'de olmayan bir talimat
// (doğrulama, satır numarası tarifi) verilmez, yoksa fark orkestrasyonu değil prompt'u ölçer.
const review = await agent(
  `Diff: ${args.diffRef}. Değişikliği "git diff ${args.diffRef}" ile oku, dokunulan dosyaların çevresini de oku. ` +
  `Üç şeyi ara. Mantık hatası: yanlış koşul, sınır değer, null/undefined, sıra, yanlış dönüş değeri. ` +
  `Güvenlik: enjeksiyon, yetki atlama, sır sızıntısı, güvenilmeyen girdinin doğrulanmaması. ` +
  `Veri kaybı ve geri alınamaz işlem: silme, üzerine yazma, migration, yarım kalan yazma.`,
  { label: 'review', phase: 'Review', schema: FINDINGS })
return review ?? { findings: [], failed: true }
