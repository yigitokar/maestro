export const meta = {
  name: 'eval-triage',
  description: 'SZZ adaylarını ele: fix gerçek bir kusur mu, bu PR mı getirdi, diff\'ten görülür mü',
  phases: [{ title: 'Triage' }],
}

// docs/eval.md 2.2: aday PR başına bir ajan, PR'a bağlanan bütün fix'lerle.
// args: { candidates: BugCandidate[] (eval/mine.ts), effort?: 'low'|'medium'|'high', maxFixes?: number }
// Repo trunk ucundadır, yani ajan geleceği görür; bu etiketleme içindir, kollar ayrı repolarda koşar.

const TRIAGE = {
  type: 'object',
  properties: {
    fixes: { type: 'array', items: {
      type: 'object',
      properties: {
        sha: { type: 'string' },
        defect: { type: 'boolean' },
        introducedHere: { type: 'boolean' },
        visibleFromDiff: { type: 'boolean' },
        reason: { type: 'string' },
        bugs: { type: 'array', items: {
          type: 'object',
          properties: {
            file: { type: 'string' }, line: { type: 'integer' },
            description: { type: 'string' }, trigger: { type: 'string' },
          },
          required: ['file', 'line', 'description', 'trigger'],
        } },
      },
      required: ['sha', 'defect', 'introducedHere', 'visibleFromDiff', 'reason', 'bugs'],
    } },
  },
  required: ['fixes'],
}

const MAX_FIXES = args.maxFixes ?? 8

const verdicts = await parallel(args.candidates.map(c => () => {
  // Merge'e en yakın fix'ler önce: PR'ın getirdiği kusur genellikle erken fark edilir.
  const fixes = c.fixes.slice(0, MAX_FIXES)
  if (c.fixes.length > fixes.length) log(`${c.id}: ${c.fixes.length} fix'ten ilk ${fixes.length}'i soruluyor`)
  const name = c.pr === null ? `merge ${c.merge.slice(0, 9)}` : `PR #${c.pr}`
  return agent(
    `Bir code review eval'i için etiketleme yapıyorsun. ${name} şu değişikliği getirdi: ` +
    `"git diff ${c.base} ${c.merge}" (${c.lines} satır, ${c.files} dosya). ` +
    `Sonradan gelen şu commit'ler bu PR'ın satırlarına dokunuyor ve fix gibi görünüyor:\n` +
    fixes.map(f => `- ${f.sha} "${f.subject}" (${f.gapDays} gün sonra; bağlantı: ${f.kinds.join(', ')})`).join('\n') +
    `\nÇalışma ağacı daha yeni bir commit'te; merge anındaki kodu "git show ${c.merge}:<dosya>" ile oku. ` +
    `Her fix için önce "git show <sha>" ile fix'i, sonra PR diff'inin ilgili kısmını oku ve üç soruyu cevapla. ` +
    `defect: fix gerçek bir kusuru mu düzeltiyor? Refactor, yeni özellik, metin/stil/kopya değişikliği, ` +
    `bağımlılık güncellemesi ve sonradan değişen bir gereksinim kusur değildir. ` +
    `introducedHere: kusur bu PR ile mi geldi? PR'dan önce de varsa false. ` +
    `visibleFromDiff: dikkatli bir reviewer yalnızca PR diff'ini ve merge anındaki repoyu okuyarak bu kusuru ` +
    `bulabilir miydi? Çalışma ortamına, konfigürasyona, veriye veya üçüncü taraf servis davranışına bağlıysa false. ` +
    `Üçü de true ise bugs listesine her ayrı kusuru yaz: merge anındaki dosya ve satır, kusurun tek cümlelik ` +
    `tanımı ve onu tetikleyen somut senaryo. Aksi halde bugs boş kalsın. Emin değilsen false de. ` +
    `Her fix için tam bir kayıt döndür, sha alanına listedeki tam SHA'yı yaz.`,
    { label: `triage:${c.id}`, phase: 'Triage', schema: TRIAGE, effort: args.effort ?? 'medium' })
}))

const results = args.candidates.map((c, i) => ({ id: c.id, triage: verdicts[i] }))
const accepted = results.filter(r => r.triage?.fixes.some(f => f.defect && f.introducedHere && f.visibleFromDiff && f.bugs.length))
log(`${accepted.length}/${results.length} aday kabul edildi, ${results.filter(r => !r.triage).length} null`)
return results
