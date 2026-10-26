export const meta = {
  name: 'eval-verify',
  description: 'Elemenin bildirdiği bug\'ları çürütmeye çalış: merge anında var mı, PR mı getirdi, fix düzeltiyor mu, diff\'ten görülür mü',
  phases: [{ title: 'Verify' }],
}

// docs/eval.md 2.3: insan onayının yerine aday başına bir ajan. Elemenin gerekçesi verilmez, yalnızca iddia:
// doğrulayan, iddiayı üreten modelin akıl yürütmesine yaslanmasın.
// args: { candidates: [{ id, pr, merge, base, lines, files, bugs: [{ file, line, description, trigger, fix }] }],
//         effort?: 'low'|'medium'|'high' }
// Repo trunk ucundadır, yani ajan geleceği görür; bu etiketleme içindir, kollar ayrı repolarda koşar.

const VERIFY = {
  type: 'object',
  properties: {
    bugs: { type: 'array', items: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        exists: { type: 'boolean' },
        introduced: { type: 'boolean' },
        fixed: { type: 'boolean' },
        visible: { type: 'boolean' },
        corrected: { type: 'boolean' },
        file: { type: 'string' }, line: { type: 'integer' },
        description: { type: 'string' }, trigger: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['index', 'exists', 'introduced', 'fixed', 'visible', 'corrected', 'file', 'line', 'description', 'trigger', 'reason'],
    } },
  },
  required: ['bugs'],
}

const verdicts = await parallel(args.candidates.map(c => () => {
  const name = c.pr === null ? `merge ${c.merge.slice(0, 9)}` : `PR #${c.pr}`
  return agent(
    `Bir code review eval'inin etiketlerini denetliyorsun. Başka bir model ${name} için aşağıdaki bug'ları ` +
    `bildirdi; senin işin her birini çürütmeye çalışmak. Etikette kalan her bug, eval'de bulunması gereken ` +
    `gerçek bir kusur sayılacak, bu yüzden yanlış bir kabul yanlış bir redden pahalıdır. ` +
    `PR'ın değişikliği: "git diff ${c.base} ${c.merge}" (${c.lines} satır, ${c.files} dosya). Çalışma ağacı ` +
    `daha yeni bir commit'te; merge anındaki kodu "git show ${c.merge}:<dosya>", PR öncesini ` +
    `"git show ${c.base}:<dosya>" ile oku.\nBildirilen bug'lar:\n` +
    c.bugs.map((b, i) =>
      `${i}. ${b.file}:${b.line}: ${b.description} Senaryo: ${b.trigger} (fix: ${b.fix})`).join('\n') +
    `\nHer bug için dört soruyu kodu okuyarak cevapla. ` +
    `exists: kusur merge anındaki kodda gerçekten var mı ve senaryo gerçekten yanlış davranışa yol açıyor mu? ` +
    `introduced: kusur PR öncesinde yok muydu, yani bu PR mı getirdi? ` +
    `fixed: "git show <fix>" bu kusuru düzeltiyor mu? Başka bir şeyi düzeltip bu satıra yalnızca dokunuyorsa false. ` +
    `visible: dikkatli bir reviewer yalnızca PR diff'ini ve merge anındaki repoyu okuyarak bulabilir miydi? ` +
    `Çalışma ortamına, veriye, konfigürasyona ya da üçüncü taraf servisin belgelenmemiş davranışına bağlıysa false. ` +
    `Emin değilsen false de. file, line, description ve trigger alanlarına kusurun merge anındaki doğru dosyasını, ` +
    `satırını, tek cümlelik tanımını ve onu tetikleyen somut senaryoyu yaz; bildirilen doğruysa aynen tekrarla ve ` +
    `corrected false olsun, düzelttiysen true. reason'a kısa gerekçeni yaz. Her bug için index'i listedeki ` +
    `numara olan bir kayıt döndür.`,
    { label: `verify:${c.id}`, phase: 'Verify', schema: VERIFY, effort: args.effort ?? 'high' })
}))

const results = args.candidates.map((c, i) => ({ id: c.id, verify: verdicts[i] }))
const ok = b => b.exists && b.introduced && b.fixed && b.visible
const confirmed = results.filter(r => r.verify?.bugs.some(ok))
log(`${confirmed.length}/${results.length} aday doğrulandı, ${results.filter(r => !r.verify).length} null`)
return results
