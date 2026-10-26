# Eval: kurulum önerisi

> Spec Seviye 4 "Eval planı"nı uygulanabilir hale getirir. Durum: kabul edildi, 2026-10-26 (kararlar bölüm 9). Kollar koşmadan önce bu belge, set ve kol script'leri dondurulur (bölüm 5); ondan sonra yapılan her değişiklik yeni bir tam koşu demektir.

## Özet

- **Set** lula'dan gelir. lula private olduğu için eğitim verisinde yoktur. Bug'lı PR'lar üç adımda seçilir: SZZ ile madencilik, ajanla eleme, insan onayı. 20 bug'lı ve 5 temiz PR.
- **Sızıntı:** Her PR, yalnızca merge commit'inin atalarını içeren taze bir repoda koşar. Sonradan gelen fix ajanın erişebildiği hiçbir yerde yoktur.
- **Kollar:** A tek ajan, B `review-changes` değişmeden. Model, araçlar ve çıktı şeması aynı. 25 PR × 2 kol × 3 tekrar = 150 hücre, karışık sırada.
- **Puanlama:** Kolu bilmeyen bir hakem ajanı puanlar, insan kontrol eder. Karar kuralı spec'teki gibidir.
- **Maliyet:** Sonnet 5.5 ile kabaca $250–400. Önce yaklaşık $15'lık bir pilot koşar.

## 1. Kaynak: lula

lula'nın varsayılan branch'i `lula-version`'dır. İlk-ebeveyn zincirinde 381 merge commit'i vardır; çoğu PR'dır ve squash değil merge stratejisiyle gelmiştir. Ayrıca 458 "fix" commit'i vardır (konu satırında `fix`, `hotfix`, `bug`, `regression`). Commit mesajları açıklayıcıdır, bu da eleme adımını ucuzlatır. Kod TypeScript ve Supabase SQL'dir.

Sınır: tek repo ve tek ekip. Sonuç lula'ya genellenir. İkinci bir repo gerekirse aynı araçlar `--repo` ile o repo üzerinde koşar.

## 2. Bug'lı PR'ları toplama

### 2.1 Madencilik (SZZ)

Her fix commit'i için `git diff -U0 fix^ fix` okunur. Değişen satırların fix öncesi hali `git blame` ile kökenine bağlanır. Kökeni bir PR'a ait olan commit, o PR'ı aday yapar. Üç bağlantı türü vardır:

| Tür | Ne yakalar | Nasıl |
|---|---|---|
| değişen satır | yanlış koşul, yanlış değer | fix'in değiştirdiği veya sildiği satırların blame'i |
| eklemenin komşusu | eksik kontrol (`next_attempt_at <= now()` gibi) | fix yalnızca satır ekliyorsa, eklemeden önceki satırın blame'i |
| SQL fonksiyonu | migration'daki fonksiyon bug'ları | fix migration'ı `create or replace function f` içeriyorsa, `f`'yi ondan önce son tanımlayan commit |

Elenenler: fix'in aynı PR içinde olması, fix'in merge'den sonraki 24 saat içinde gelmesi, kilit dosyaları, `.md` ve snapshot dosyaları.

Deneme koşusunun sonucu aşağıda (`python3 eval/probe/szz_probe.py <lula> origin/lula-version`, 2026-10-25, yaklaşık 100 saniye). Bir PR yalnızca en güçlü bağlantı türüne sayılır:

| En güçlü bağlantı | ≤200 satır | 201-800 | 801-2000 | >2000 |
|---|---:|---:|---:|---:|
| değişen satır | 42 | 54 | 30 | 22 |
| yalnızca eklemenin komşusu | 3 | 14 | 3 | 0 |

Toplam 168 aday PR var, bunların 113'ü ≤800 satır. SQL bağlantısı 3 PR'a dokunuyor, üçünde de başka bir bağlantı da var. Doğrulama: README'deki bilinen fix (`2a877f1a`) PR #546'ya üç bağlantı türünün üçüyle de bağlanıyor. #546 51 dosyalık, yaklaşık 4.150 satırlık bir PR'dır, yani tablonun ">2000" sütunundadır.

SZZ gürültülüdür. Refactor'lar, biçim değişiklikleri ve kusurun yalnızca yanındaki satırlar da bağlanır. Bu yüzden ikinci adım gerekir.

### 2.2 Ajanla eleme

Her (PR, fix) çifti için tek bir ajan koşar. Bu, Maestro'nun kendisiyle yazılmış bir workflow'dur (`eval/workflows/triage.js`). Ajan, fix commit'inde kurulmuş bir repoda çalışır, böylece hem PR'ı hem fix'i görür. Model Sonnet 5.5, effort `medium`. Dört soruya cevap verir:

1. Fix gerçekten bir kusuru mu düzeltiyor, yoksa refactor ya da özellik mi?
2. Kusur bu PR ile mi geldi?
3. Kusur, PR diff'i ve merge anındaki repo okunarak görülebilir mi? Çalışma zamanı ortamına, konfigürasyona ya da üçüncü taraf API davranışına bağlı bug'lar elenir.
4. Her bug için: merge anındaki dosya ve satır, tek cümlelik tanım ve tetikleyen senaryo.

113 aday için tahmini maliyet $10–15. Eleme ajanı geleceği görür, bu bir sorun değildir. Kendi state dizini kollarınkinden ayrıdır.

### 2.3 İnsan onayı

Elemeden geçenleri (tahminen 40–60 aday) kullanıcı gözden geçirir. Her aday için PR diff'ini, fix diff'ini ve eleme metnini görür; kabul eder, reddeder ya da tanımı düzeltir. Aday başına 3–5 dakika sürer, toplam 2–3 saat.

- **Etiket bug başınadır, PR başına değil.** #546'da iki bug vardı.
- **Seçim:** 20 PR, boyuta göre katmanlı: 8 tanesi ≤200 satır, 12 tanesi 201–800 satır. 800 satır üstü PR'lar kapsam dışıdır. Hem B'nin maliyeti bulgu sayısıyla büyür, hem de havuzdaki adayların çoğu 800'ün altındadır. Bu sınır raporda yazılır.
- **Pilot için ayrılanlar:** Kabul edilen 3 PR daha pilota ayrılır. Bunlar 20'nin içinde değildir.

### 2.4 Temiz PR'lar

Bir PR şu dört koşulu sağlıyorsa temizdir:

- `lula-version`'ın ucundan en az 90 gün önce merge edilmiş,
- hiçbir bağlantı türüyle bir fix'e bağlanmamış,
- eklediği satırlar ya hâlâ uçta duruyor ya da fix olmayan bir commit tarafından kaldırılmış,
- boyutu bug setine benziyor: 2 tanesi ≤200, 3 tanesi 201–800 satır.

Denemede ilk iki koşulu 64 PR sağlıyor. Seçilen 5'i kullanıcı onaylar. Bir kol temiz bir PR'da gerçek bir bug bulursa bu yanlış pozitif sayılmaz (bölüm 6).

### 2.5 Kayıt biçimi

```json
{
  "id": "lula-546",
  "repo": "lula",
  "merge": "<M sha>",
  "kind": "bug",
  "lines": 343,
  "bugs": [
    {
      "id": "lula-546-a",
      "file": "lib/moderation/image-moderation-queue.ts",
      "line": 120,
      "description": "tek cümle",
      "trigger": "tetikleyen senaryo",
      "fix": "<fix sha>",
      "link": "modified"
    }
  ]
}
```

Etiketler private lula kodunu anlatır. Bu yüzden araçlar maestro'da, veriler git'e girmeyen `eval/data/` altında durur.

## 3. Sızıntı önlemleri

**Taze repo.** Her PR şöyle kurulur:

```bash
git init -q <cell> && git -C <cell> fetch -q <lula> <M> && git -C <cell> checkout -q --detach <M> && rm <cell>/.git/FETCH_HEAD
```

Bu repoda remote yoktur ve yalnızca `M`'nin ataları bulunur. Komut PR #546'nın merge commit'iyle (`7964fab`) denendi. Sonuç: `git log --all` yalnızca `M`'ye kadar gidiyor, `git cat-file -t 2a877f1a` "Not a valid object name" veriyor, `.git` altında ne ref ne remote ne de lula'nın yolu kalıyor. lula'ya hiçbir şey yazılmıyor. Gerekçe: salt-okur bash `git log --all` ve `git show <sha>` çalıştırmaya izin verir. lula'nın bir worktree'si, nesne deposunu paylaştığı için gelecekteki fix'i gösterir.

**State dizini repo dışında.** Varsayılan `<cwd>/.maestro/`'dur. Journal'lar bulgu taşır, yani sonraki bir hücrenin ajanı önceki hücrelerin cevaplarını `cat` ile okuyabilirdi. Her hücre `--state-dir` ile repo dışına yazar.

**Yol sınırı yok.** `cat`, `ls`, `find` ve `rg` cwd dışını okuyabilir. Bu bilinçli bir karardır ([decisions.md](decisions.md), "Dosya araçlarında yol sınırı"). Dolayısıyla ne prompt'ta ne de lula'nın merge anındaki `CLAUDE.md`'sinde orijinal lula yolu ya da state dizini geçmemelidir. Bu kontrol kurulumda yapılır.

**Sonradan trace denetimi.** Her hücrenin trace'i, yani ajanların araç çağrıları, üç şey için taranır: hücre reposu dışındaki mutlak yollar, `--all` ve hücre reposunda olmayan SHA'lar. İşaretlenen hücreler raporda listelenir ve bir kez yeniden koşar.

**Önceki ölçüm hakkında not.** README'deki "bug'lı kurulum" bir ters-fix diff'iydi (`2a877f1a 2a877f1a^1`) ve lula'nın bir worktree'sinde koştu. Prompt'taki diffRef fix'in SHA'sını içeriyordu, `git show 2a877f1a` fix'in mesajını gösterir ve diff'in kendisi kaldırılan kontrolleri birebir gösteriyordu. O koşu bir duman testidir, kanıt değildir. Ters-fix diff'leri ucuz ve kesin etiketli bir duman seti olarak kalır ama 20'ye sayılmaz. Ajanların fix'e bakıp bakmadığı o koşuların trace'lerinden `maestro show` ile görülebilir.

## 4. Kollar

| | A: tek ajan | B: review-changes |
|---|---|---|
| Script | `eval/workflows/single-review.js` | `examples/workflows/review-changes.js`, değişmeden |
| Ajanlar | 1 | 3 bulucu, bulgu başına 3 skeptik, 1 sentez |
| Prompt | B'nin diff satırı ve üç boyut talimatı tek prompt'ta | spec Örnek 1 |
| Şema | B'nin `FINDINGS` şeması | aynı |
| Araçlar | varsayılan salt-okur set | aynı |
| Effort | `high` | bulucular API varsayılanı, skeptikler `high` |

Ortak ayarlar:

- **Model:** iki kolda aynı, `MAESTRO_MODEL` ile. Önerilen Sonnet 5.5, çünkü maliyeti ölçüldü. Alternatif, kodun varsayılanı olan Opus 5.5.
- **diffRef:** `M^1 M`. Çalışma ağacı `M`'de durur.
- **Bütçe:** Hücre başına 400k çıktı tokeni. Ölçülen en yüksek koşu 135k'ydı. Bütçe dolarsa B skeptiklerini sessizce kaybeder, bu yüzden `budget_exceeded` her hücre için kaydedilir.

**A'nın effort'u neden `high`:** İddia, tek ajanın en iyi hâline karşı tutmalı. B'nin içinde de `high` effort vardır.

Puanlanan şey her kolun son dönüş değeridir. B'de bu sentez çıktısıdır. Hiç bulgu yoksa iki kol da `{ findings: [] }` döner.

## 5. Koşu protokolü

**Dondurma.** Tam koşudan önce `eval/data/manifest.json` yazılır. İçinde şunlar bulunur: maestro commit SHA'sı, `set.json`, kol script'leri ve hakem prompt'unun hash'leri, model ve bütün parametreler. Eval sonuçları görüldükten sonra B'nin prompt'ları değişmez; değişirse yeni bir manifest ve yeni bir tam koşu gerekir.

**Pilot.** Ayrılmış 3 PR × 2 kol × 1 tekrar. Hücre başına gerçek doları ve duvar saatini ölçer. Hakemi ve trace denetimini sınar. Tahmini maliyet yaklaşık $15.

**Tam koşu.** 150 hücre. Sıralama:

- Her tekrar, PR'ları sabit tohumlu bir karışık sırayla dolaşır.
- Her PR'da önce hangi kolun koşacağı rastgeledir.
- Her hücre taze bir runId alır, `--resume` kullanılmaz.

`eval/run.js` hücre düzeyinde kaldığı yerden devam eder: `results.jsonl`'da biten hücreler atlanır.

**Hatalar.** Run'ın düşmesi, API hatası ya da script'in `null` dönmesi altyapı hatası sayılır. Böyle bir hücre bir kez yeniden koşar; yine düşerse hata olarak kaydedilir ve raporda yer alır. `null` dönüş şu durumlarda olur: B'de sentez ajanı hata verince, A'da tek ajan hata verince. Bu kural olmasaydı, tek bir başarısız sentez çağrısı o tekrarda B'nin bütün doğrulanmış bulgularını sessizce silerdi. B'nin içindeki null'lar ise (bir bulucu ya da skeptik) B'nin kendi davranışıdır: hücre olduğu gibi puanlanır ve null sayısı kaydedilir. `budget_exceeded` yeniden koşmaz, çünkü tavan önceden kayıtlıdır.

**Her hücre için kaydedilenler:**

- run bilgisi: runId, kol, tekrar, PR
- sonuç: bulgular
- maliyet: usage (cache'siz girdi, cache yazımı, cache okuması, çıktı), dolar
- koşu: duvar saati, ajan sayısı, null ve skipped ajanlar
- trace denetimi bayrakları

## 6. Puanlama

**Hakem.** `eval/workflows/judge.js`, hücre başına bir ajan, model Opus 5.5. Bulgular karıştırılmış sırada gelir, kol adı görünmez. Her hücre ayrı puanlanır, böylece hakem kolları birbiriyle kıyaslamaz.

Hakemin girdisi: o PR'ın etiketleri (tanım, dosya, satır, fix diff'i) ve bulgu listesi. Çıktısı iki parçadır:

- **Her etiket için:** eşleşen bulgular. Eşleşme kök nedenin aynı olması demektir; yalnızca aynı dosya ya da aynı satır olması yetmez.
- **Eşleşmeyen her bulgu için:** `false`, `real-unlabeled` ya da `unclear`, gerekçesiyle. Hakem bu kararı hücre reposunda `M`'deki kodu okuyarak verir.

**İnsan kontrolü.** Kullanıcı şunlara bakar:

- etiketli bug'lara dair bütün eşleşme kararları: her etiket × 6 hücre, her biri bir cümleyi bir listeyle karşılaştırmak,
- bütün `real-unlabeled` ve `unclear` kararlar,
- `false` kararların %20'si.

Örneklemde uyuşmazlık %10'u geçerse `false` kararların hepsine bakılır.

**Metrikler:**

- **Yakalama oranı** = yakalanan etiketli bug sayısı / etiketli bug sayısı.
- **Yanlış pozitif / PR** = `false` bulgular / 25 PR. Temiz PR'lar dahildir.
- `real-unlabeled` ve `unclear` ayrı raporlanır. Yanlış pozitif sayılmazlar ve sonradan paydaya eklenmezler.
- Çıktı tokeni, toplam girdi (cache'siz + yazım + okuma), dolar ve duvar saati.

Her metrik kol ve tekrar başına hesaplanır, üç tekrarın medyanı alınır.

**Karar kuralı (spec):** B'nin yanlış pozitifi A'nınkinin yarısından az ve yakalama oranı A'nınkinden düşük değilse Seviye 0 hedefi tutmuş sayılır. Token maliyeti ayrıca raporlanır, eşiğe girmez.

**Çözünürlük.** 20 bug ile bir bug 5 puandır. Bu yüzden rapor bug başına eşleştirilmiş bir tablo da verir: ikisi de yakaladı / yalnızca B / yalnızca A / ikisi de kaçırdı. "Yakaladı", üç tekrarın en az ikisinde yakalamak demektir. Tek bug'lık bir fark tek başına okunmaz.

## 7. Maliyet ve süre

| Kalem | Hücre | Tahmin | Dayanak |
|---|---:|---:|---|
| Eleme | 113 | $10–15 | tahmin, Sonnet `medium` |
| Pilot | 6 + hakem | ~$15 | B ölçümü |
| B | 75 | $190–270 | ölçülen $2,55–3,56, 343 satırlık diff |
| A | 75 | $15–40 | tahmin, pilot ölçer |
| Hakem | 150 | pilot ölçer | Opus |

Toplamın kabaca $250–400 olması beklenir. Opus kollarda seçilirse pilot yeniden fiyatlar. Duvar saati henüz ölçülmedi, onu da pilot ölçer.

Kullanıcının zamanı: etiket onayı için 2–3 saat, hakem kontrolü için 1–2 saat.

## 8. Dosyalar ve sıra

| Dosya | İş |
|---|---|
| `eval/mine.js` | SZZ ve üç bağlantı türü → `eval/data/candidates.json` |
| `eval/workflows/triage.js` | aday başına eleme ajanı |
| `eval/prepare.js` | hücre repolarını kurar, CLAUDE.md'yi yol için tarar |
| `eval/workflows/single-review.js` | A kolu |
| `eval/run.js` | 150 hücreyi koşar, `results.jsonl`'a yazar, trace'leri denetler |
| `eval/workflows/judge.js` | hakem |
| `eval/report.js` | metrikler, eşleştirilmiş tablo, karar |

`eval/data/` `.gitignore`'a eklenir. Hiçbiri pakete (`files`) girmez.

Sıra:

1. Madencilik ve eleme (ajan, ~$15).
2. Etiket onayı (kullanıcı).
3. Hücre repolarını kurma.
4. Pilot ve kontrolü.
5. Dondurma.
6. Tam koşu.
7. Hakem ve insan kontrolü.
8. Rapor. Spec ve README'ye sonuç satırı eklenir.

## 9. Kararlar

2026-10-26'da kararlaştırıldı:

1. **Kolların modeli:** Sonnet 5.5 (`claude-sonnet-5-5`), çünkü maliyeti ölçüldü. Opus 5.5 seçilmedi.
2. **A'nın effort'u:** `high`.
3. **Veri yeri:** maestro'da git'e girmeyen `eval/data/`.
4. **Bütçe:** kabaca $250–400.
5. **Kapsam:** 800 satır üstü PR'lar dışarıda kalır. Bu yüzden tek bilinen örneğimiz #546 (yaklaşık 4.150 satır) sete girmez; rapor bunu kapsam sınırı olarak yazar.
