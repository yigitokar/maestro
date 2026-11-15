---
name: maestro-workflow-authoring
description: Maestro Workflow tool'u için script yazma rehberi (meta bloğu, host API, null/throw davranışı, determinizm, pipeline/parallel seçimi, kalıplar, resume). Workflow tool'una script vermeden önce oku.
---

# Maestro workflow script'i yazmak

Kontrol akışı kodda, muhakeme ajanda. Script'i sen yazarsın, çalıştıran düz bir JavaScript runtime'ıdır. Her `agent()` temiz context'le başlar; ajanlar birbirini görmez, veri yalnızca script üzerinden akar.

Script'i Workflow tool'una `script` alanında inline ver (`scriptPath` ya da kayıtlı `name` de olur). Tool hemen `runId` döner; sonuç bitince gelir.

Run, MCP sunucusunun dizininde (oturumun açıldığı klasörde) çalışır. İş başka bir repo üzerindeyse `cwd` ile o dizini ver. Tercihen o reponun bir worktree'sini ver, birinin kullandığı ana checkout'u değil. Ajanlar orada çalışır, yazanlar oranın git reposundan branch açar, `.maestro/` de oraya yazılır. Resume ederken aynı `cwd`'yi ver.

## Meta bloğu

Her script `export const meta = {...}` ile başlar. **Saf literal** olmalı: değişken, fonksiyon çağrısı, spread, ifadeli template string yok.

```js
export const meta = {
  name: 'review-changes',                 // zorunlu
  description: 'Diff\'i üç boyutta incele', // zorunlu, izin diyaloğunda görünür
  phases: [{ title: 'Find' }, { title: 'Verify' }],
  maxAgents: 60,                          // isteğe bağlı sert tavan (varsayılan 1000)
}
```

`meta.phases` varsa `phase(title)` ve `opts.phase` yalnızca buradaki başlıkları kabul eder, başka başlık throw eder. Bilinmeyen `meta` alanları (ör. `maxAgent` yazım hatası) run başında uyarı log'u üretir; geçerli alanlar `name`, `description`, `phases`, `maxAgents` ve `whenToUse`'dur. Tavanı prompt'a "10 ajan altı kal" diye yazma, `maxAgents` ile koda koy.

## Host API

Script gövdesi async'tir: `await` ve en üstte `return` serbest. Dönüş değeri run'ın sonucudur.

| API | Davranış |
|---|---|
| `agent(prompt, opts?)` | Ajan koşar. `schema` varsa doğrulanmış obje, yoksa final metin döner. Terminal API hatası, kullanıcının atlaması veya koşarken bütçe aşımı → **null**. Geçersiz schema (kök `object` değil, `required ⊄ properties`), bütçe girişte yetmiyor, ajan tavanı doldu, izolasyonsuz yazma aracı istendi → **throw**. |
| `parallel(thunks)` | Hepsini bekler (bariyer). Ajan/çalışma zamanı hatası atan thunk'ın slotu **null** olur; programcı/konfigürasyon hataları (`ReferenceError`, `Math.random()`, `unknown_tool`, `unknown_phase`, izolasyonsuz yazma aracı vb.) doğrudan **throw** eder. |
| `pipeline(items, ...stages)` | Her öğe aşamaları bağımsız geçer, aşamalar arası bariyer yok. Aşama `(prev, item, index)` alır; ilk aşamada `prev === item`. Çalışma zamanı hatası atan aşama öğeyi null yapar ve kalan aşamaları atlar; programcı/konfigürasyon hataları doğrudan **throw** eder. Null **dönen** aşama normal değerdir, sonraki aşamaya geçer. |
| `phase(title)` | Sonraki ajanları bu ilerleme kutusuna koyar. Paralel kodda `opts.phase` kullan. |
| `log(msg)` | İlerleme ağacının üstünde anlatıcı satırı. |
| `args` | Tool çağrısındaki `args`, olduğu gibi. Diziyi string'e çevirip verme. |
| `budget` | `{ total, spent(), remaining() }`. `total` yoksa null ve `remaining()` Infinity. Havuz paylaşılır, sınır serttir. |
| `workflow(nameOrRef, args?)` | Başka bir workflow'u alt adım olarak koşar. Aynı semafor, sayaç ve bütçe. Yalnızca bir seviye: çocuğun içinde `workflow()` throw eder. |

`opts`: `label` (görüntü adı), `phase`, `schema`, `model`, `effort` (`low` … `max`), `isolation: 'worktree'`, `tools` (izinli araçlar). Sunucu `--runner auto` ile çalışıyorsa `opts.model` ajan bazında farklı sağlayıcılara yönlendirilebilir (`claude-*` → Anthropic, `gpt-*` / `o3` → Codex). Varsayılan araçlar salt-okurdur: `read_file`, `grep`, `glob`, `bash` (ls, cat, git log/diff/status/show, rg, find). Yazma araçları (`write_file`, `edit_file`, `shell`, `git_commit`) yalnızca `isolation: 'worktree'` ile verilir. Script'in dışında tanımlanmış özel araçlar (`.maestro/tools/*.js`, örneğin `arxiv_search`) de adıyla seçilir; hangilerinin olduğu Workflow aracının açıklamasının sonunda yazar. `tools` varsayılan seti genişletmez, yerine geçer: özel aracın yanında gereken okuma araçlarını da say.

Kural: ajan seviyesindeki hata sessizce null'a düşer, script seviyesindeki hata run'ı öldürür. Sonuçlara `.filter(Boolean)` uygula ve kaç öğenin düştüğünü `log()` ile söyle.

Ajanın final metni çağıranın kullanacağı ham veridir. Ajan ne istendiğini yalnızca prompt'tan bilir, bu yüzden prompt kendi başına yetmeli.

## Determinizm

`Date.now()`, `Math.random()`, argümansız `new Date()` throw eder. `process`, `require`, `fetch`, `console`, `setTimeout` tanımlı değildir. Sebep resume: cache anahtarı `sha256(prompt + opts)` + aynı içeriğin kaçıncı çağrısı olduğu. Prompt her koşuda değişirse cache hiç tutmaz.

- Zaman damgası gerekiyorsa `args` ile ver: `new Date(args.ts)` çalışır.
- Rastgelelik yerine index'e göre prompt varyasyonu kullan.
- `label` ve `phase` anahtara girmez; değiştirmek cache'i bozmaz.

## Pipeline varsayılan

Çok aşamalı işte `pipeline` kullan. Bariyer (`parallel` sonra `parallel`) yalnızca aşama N'nin aşama N-1'in **tüm** sonuçlarına ihtiyacı varsa meşrudur: tüm sonuçlar üzerinde dedup, "hiç bulgu yok → doğrulamayı atla" gibi erken çıkış, ya da "diğer bulgularla karşılaştır".

Smell test:

```js
const a = await parallel(...)
const b = transform(a)          // map/filter/flatten, öğeler arası bağımlılık yok
const c = await parallel(b.map(...))
```

Ortadaki dönüşüm bariyer istemiyor; onu bir pipeline aşamasının içine al. En yavaş bulucu en hızlının üç katı sürüyorsa bariyer, hızlıların bekleme süresinin üçte ikisini boşa harcar.

## Kalıplar

- **Adversarial verify**: her bulguya N bağımsız skeptik, her biri ÇÜRÜTMEYE çalışır; çoğunluk çürütürse at. "Emin değilsen refuted=true" de.
- **Perspektif çeşitliliği**: aynı skeptiği N kez çağırmak yerine her birine ayrı mercek ver (tekrar üretilebilirlik, niyet/edge case, mevcut testler).
- **Judge panel**: N farklı açıdan (MVP-first, risk-first, user-first) tasarım üret, paralel jüriyle puanla, kazanandan sentezle.
- **Loop-until-dry**: boyutu bilinmeyen keşifte iki tur üst üste yeni şey çıkmayana kadar dön. Dedup'ı `seen` üzerinden yap, `confirmed` üzerinden değil; yoksa jürinin reddettiği bulgu her turda geri gelir.
- **Multi-modal sweep**: aynı soruyu farklı arama yollarıyla (dosya adı, içerik, sembol, git log) paralel ajanlara ver.
- **Completeness critic**: son ajan "ne eksik?" diye sorar; bulduğu şey bir sonraki turun işi olur.
- **No silent caps**: top-N, örnekleme, tur tavanı gibi her sınırı `log()` ile söyle.
- **Fan-out writers → coordinator merge**: N izole yazan ajan (`isolation: 'worktree'`, yazma araçları) paralel çalışır. Her biri, runtime'ın açtığı `wf/<runId>/<label>` branch'ine commit eder ve `{ summary, filesTouched }` döner; `branchName`'i runtime ekler. Commit etmeyen veya branch değiştiren ajan null döner. Diff metnini script'e alma. Tek bir izole koordinatör branch'leri cherry-pick eder ve çatışmaları çözer; birleştirme script'in işi değildir. Yazan ajanlara benzersiz `label` ver.

## Örnek: bul → doğrula → sentezle

```js
export const meta = { name: 'review-changes', description: 'Üç boyut, her bulguya üç skeptik',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }] }

const DIMENSIONS = ['correctness', 'security', 'data-loss']
const perDim = await pipeline(DIMENSIONS,
  d => agent(`Diff: ${args.diffRef}. Yalnızca ${d} sorunlarını ara.`, { label: `find:${d}`, phase: 'Find', schema: FINDINGS }),
  async (found, d) => {
    if (!found) { log(`${d}: bulucu null`); return [] }
    return parallel(found.findings.map(f => async () => {
      const votes = await parallel([0, 1, 2].map(i => () =>
        agent(`Bu iddiayı ÇÜRÜTMEYE çalış: ${f.claim} (${f.file}:${f.line}). Emin değilsen refuted=true. Perspektif ${i}.`,
          { label: `verify:${f.file}:${f.line}#${i}`, phase: 'Verify', schema: VERDICT, effort: 'high' })))
      return votes.filter(Boolean).filter(v => !v.refuted).length >= 2 ? { ...f, dimension: d } : null
    }))
  })
const confirmed = perDim.filter(Boolean).flat().filter(Boolean)
log(`${confirmed.length} bulgu oylamayı geçti`)
if (!confirmed.length) return { findings: [] }
return agent(`Ciddiyete göre sırala, her birine tek cümle düzeltme öner:\n${JSON.stringify(confirmed)}`,
  { phase: 'Synthesize', schema: FINDINGS })
```

`Verify`, `Find`'ın bitmesini beklemez; tek bariyer sentezdir.

## Örnek: loop-until-dry

```js
export const meta = { name: 'find-edge-cases', description: 'Yeni şey çıkmayana kadar ara',
  phases: [{ title: 'Find' }, { title: 'Verify' }] }

const LENSES = ['sınır değerler', 'eşzamanlılık', 'hata yolları']
const seen = new Set(), confirmed = []
let dry = 0, round = 0
while (dry < 2 && round < 6) {
  round++
  const found = (await parallel(LENSES.map((lens, i) => () =>
    agent(`${args.target} içinde edge case ara. Mercek: ${lens}. Bilinenler: ${[...seen].join(', ') || 'yok'}`,
      { label: `find:${i}:r${round}`, phase: 'Find', schema: BUGS })))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(b.key))
  if (!fresh.length) { dry++; continue }
  dry = 0
  fresh.forEach(b => seen.add(b.key))
  const judged = await parallel(fresh.map(b => () =>
    agent(`"${b.desc}" gerçek bir hata mı? Kanıt göster.`, { phase: 'Verify', schema: VERDICT })
      .then(v => v && v.real ? b : null)))
  confirmed.push(...judged.filter(Boolean))
}
if (round >= 6) log('tur tavanına ulaşıldı')
return { confirmed, rounds: round }
```

Tam hâlleri (`FINDINGS`, `VERDICT`, `BUGS` şemalarıyla): `examples/workflows/`.

## Resume ve journal

Her run `.maestro/runs/<runId>/` altında `script.js`, `args.json`, `journal.jsonl` ve `blobs/` tutar. Script'i düzenleyip `resumeFromRunId` ile tekrar koşunca değişmeyen her çağrı cache'den döner. İsabet çağrı başına bakılır: ortadaki bir prompt değişirse yalnızca o çağrı ve sonucunu prompt'una alan çağrılar canlı koşar, bağımsız kardeşler cache'den gelir. Aynı script ve aynı args sıfır canlı çağrı demektir. Yalnızca `ok` kayıtlar cache isabetidir: null (API hatası) ve skipped (bütçe veya atlama) kayıtlar resume'da tekrar koşar. Bütçeyi artırıp resume etmek yarım kalan ajanları böyle canlandırır.

Beklenmedik ya da boş bir sonucu teşhis etmeden önce `journal.jsonl`'i oku (veya `node ~/maestro/bin/maestro runs --cwd <cwd>` ve `maestro show <runId> --cwd <cwd>` çalıştır). Her satır bir çağrının gerçek dönüş değerini ve status'unu tutar. Cache'teki sonucun dolu olduğunu varsayma.

Kullanıcı run'ı izlemek isterse ona şu komutu ver:

```bash
node ~/maestro/bin/maestro viz <runId> --cwd <run'ın cwd'si>
```

Komut tarayıcıda canlı bir zaman çizelgesi açar. `--out rapor.html` ile tek dosyalık bir rapor yazar. Ajanların ne zaman başladığı, slot beklediği ve bittiği `events.jsonl`'de durur.

Run bittiğinde oturumda satır içi bir widget aracı varsa (Claude masaüstündeki `show_widget` gibi) zaman çizelgesini sohbette göster:

```bash
node ~/maestro/bin/maestro viz <runId> --cwd <run'ın cwd'si> --widget
```

Komutun stdout'unu hiç değiştirmeden widget koduna ver. Aracın kendi kuralı ilk kullanımdan önce bir hazırlık çağrısı istiyorsa önce onu yap. Parça bir anlık görüntüdür. Run sürerken göstermek istersen bittiğinde yeniden üret. Çok büyük run'larda (yüzlerce ajan) parça uzar; kullanıcı istemedikçe tarayıcı komutunu öner.
