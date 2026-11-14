export const meta = {
  name: 'single-review',
  description: 'A kolu: aynı diff\'i tek ajan inceler',
  phases: [{ title: 'Review' }],
  maxAgents: 1,
}

// docs/eval.md bölüm 4, A kolu. B (examples/workflows/review-changes.js) ile aynı model, aynı salt-okur
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

const review = await agent(
  `Diff: ${args.diffRef}. Değişikliği "git diff ${args.diffRef}" ile oku, dokunulan dosyaların çevresini de oku. ` +
  `Bu değişikliğin getirdiği gerçek sorunları bul: mantık hatası (yanlış koşul, sınır değer, null/undefined, sıra, ` +
  `yanlış dönüş değeri), güvenlik (enjeksiyon, yetki atlama, sır sızıntısı, güvenilmeyen girdinin doğrulanmaması), ` +
  `veri kaybı ve geri alınamaz işlem (silme, üzerine yazma, migration, yarım kalan yazma). ` +
  `Her bulguyu raporlamadan önce kodu okuyarak doğrula; emin olmadığını yazma. ` +
  `Her bulgu için dosya, head'deki satır numarası, iddia ve hatayı tetikleyen senaryoyu ver. Sorun yoksa boş liste döndür.`,
  { label: 'review', phase: 'Review', schema: FINDINGS })
return review ?? { findings: [], failed: true }
