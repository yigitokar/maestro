# Eval: kurulum önerisi

> Spec Seviye 4 "Eval planı"nı uygulanabilir hale getirir. Durum: kabul edildi, 2026-10-26 (kararlar bölüm 9); set hazırlığı yazıldı, kol koşusu, hakem ve rapor henüz yazılmadı (bölüm 8). Kollar koşmadan önce bu belge, set ve kol script'leri dondurulur (bölüm 5); ondan sonra yapılan her değişiklik yeni bir tam koşu demektir.

## Özet

- **Set** lula'dan gelir. lula private olduğu için eğitim verisinde yoktur. Bug'lı PR'lar üç adımda seçilir: SZZ ile madencilik, ajanla eleme, insan onayının yerine ajanla doğrulama (karar 8). 20 bug'lı ve 5 temiz PR.
- **Sızıntı:** Her PR, yalnızca merge commit'inin atalarını içeren taze bir repoda koşar. Sonradan gelen fix ajanın erişebildiği hiçbir yerde yoktur.
- **Kollar:** A tek ajan, B `review-changes` değişmeden. Model, araçlar ve çıktı şeması aynı. 25 PR × 2 kol × 3 tekrar = 150 hücre, karışık sırada.
- **Puanlama:** Kolu bilmeyen bir hakem ajanı puanlar, insan kontrol eder. Karar kuralı spec'teki gibidir.
- **Maliyet:** Sonnet 5.5 ile kabaca $250–400. Önce yaklaşık $15'lık bir pilot koşar.

## 1. Kaynak: lula

lula'nın varsayılan branch'i `lula-version`'dır. İlk-ebeveyn zincirinde 381 merge commit'i vardır; çoğu PR'dır ve squash değil merge stratejisiyle gelmiştir. Ayrıca 458 "fix" commit'i vardır (konu satırında `fix`, `hotfix`, `bug`, `regression`); bölüm 2.2'deki geniş desenle bu sayı 547 olur. Commit mesajları açıklayıcıdır, bu da eleme adımını ucuzlatır. Kod TypeScript ve Supabase SQL'dir.

Sınır: tek repo ve tek ekip. Sonuç lula'ya genellenir. İkinci bir repo gerekirse aynı araçlar `--repo` ile o repo üzerinde koşar.

## 2. Bug'lı PR'ları toplama

### 2.1 Madencilik (SZZ)

Her fix commit'i için `git diff -U0 fix^ fix` okunur. Değişen satırların fix öncesi hali `git blame` ile kökenine bağlanır. Kökeni bir PR'a ait olan commit, o PR'ı aday yapar. Üç bağlantı türü vardır:

| Tür | Ne yakalar | Nasıl |
|---|---|---|
| değişen satır | yanlış koşul, yanlış değer | fix'in değiştirdiği veya sildiği satırların blame'i |
| eklemenin komşusu | eksik kontrol (`next_attempt_at <= now()` gibi) | fix yalnızca satır ekliyorsa, eklemeden önceki satırın blame'i |
| SQL fonksiyonu | migration'daki fonksiyon bug'ları | fix migration'ı `create or replace function f` içeriyorsa, `f`'yi ondan önce son tanımlayan commit |

Elenenler: fix'in aynı PR içinde olması, kilit dosyaları, `.md` ve snapshot dosyaları. Başlangıçta merge'den sonraki 24 saat içinde gelen fix'ler de eleniyordu. Bu kural 2026-10-26'da kaldırıldı (`--min-gap-days 0`), çünkü merge'den hemen sonra gelen hotfix, spec'in aradığı şeyin ta kendisidir.

Deneme koşusunun sonucu aşağıda (`python3 eval/probe/szz_probe.py <lula> origin/lula-version`, 2026-10-25, yaklaşık 100 saniye). Bir PR yalnızca en güçlü bağlantı türüne sayılır:

| En güçlü bağlantı | ≤200 satır | 201-800 | 801-2000 | >2000 |
|---|---:|---:|---:|---:|
| değişen satır | 42 | 54 | 30 | 22 |
| yalnızca eklemenin komşusu | 3 | 14 | 3 | 0 |

Toplam 168 aday PR var, bunların 113'ü ≤800 satır. SQL bağlantısı 3 PR'a dokunuyor, üçünde de başka bir bağlantı da var. Doğrulama: README'deki bilinen fix (`2a877f1a`) PR #546'ya üç bağlantı türünün üçüyle de bağlanıyor. #546 51 dosyalık, yaklaşık 4.150 satırlık bir PR'dır, yani tablonun ">2000" sütunundadır.

SZZ gürültülüdür. Refactor'lar, biçim değişiklikleri ve kusurun yalnızca yanındaki satırlar da bağlanır. Bu yüzden ikinci adım gerekir.

### 2.2 Ajanla eleme

Her aday PR için tek bir ajan koşar ve PR'a bağlanan bütün fix'lere bakar; en fazla 8 fix, merge'e en yakın olanlar önce. Bu, Maestro'nun kendisiyle yazılmış bir workflow'dur (`eval/workflows/triage.js`). Ajan, madencilikte kullanılan trunk ucunda taze kurulmuş bir repoda çalışır (`eval/data/repos/<repo>-tip`), böylece hem PR'ı hem fix'leri görür; merge anındaki kodu `git show <merge>:<dosya>` ile okur. Model Sonnet 5.5, effort `medium`. Her fix için dört soruya cevap verir:

1. Fix gerçekten bir kusuru mu düzeltiyor, yoksa refactor ya da özellik mi?
2. Kusur bu PR ile mi geldi?
3. Kusur, PR diff'i ve merge anındaki repo okunarak görülebilir mi? Çalışma zamanı ortamına, konfigürasyona ya da üçüncü taraf API davranışına bağlı bug'lar elenir.
4. Her bug için: merge anındaki dosya ve satır, tek cümlelik tanım ve tetikleyen senaryo.

Eleme ajanı geleceği görür, bu bir sorun değildir: kollar ayrı repolarda koşar ve elemenin state dizini (`eval/data/state`) kollarınkinden ayrıdır.

Setin kullandığı yapılandırma (2026-10-26):

```bash
node eval/mine.ts --repo <lula> --ref origin/lula-version --fix-pattern broad --min-gap-days 0 --max-lines 2000
```

```bash
npm run build && node eval/triage.js
```

**Pilot (2026-10-26).** Beş aday farklı boyut ve bağlantı türlerinden seçildi, koşu 1 dakika 53 saniye sürdü ve $0,72 tuttu. Aday başına maliyet $0,14 olduğu için 113 adayın tahmini maliyeti yaklaşık $16'dır. Gerekçeler ayrıntılıydı ama her cümlesi doğru değildi. Örneğin lula-76 reddedildi; fix'in konusu "kullanıcılar arası veri sızıntısı" idi. Elle doğrulandı: sızıntıya yol açan `cachedPersonas` önbelleği PR'dan önce de vardı ve PR o satırlara dokunmadı, yani red doğru. Ajanın "PR `prompts.ts`'te yalnızca boşluk değiştirdi" demesi ise yanlıştı: PR aynı dosyada araç listesini değiştirmişti. SZZ bağlantısı da muhtemelen bu komşu değişiklikten geliyordu. Satır numaraları merge anına göredir; bu da elle doğrulandı (lula-226: `isTerminalResultError` merge anında 377. satırda, trunk ucunda artık yok).

Bir PR'ın birkaç fix'i genellikle aynı bug'ı bildirir. Özet bu yüzden bug'ları aday başına dosya:satır üzerinden tekilleştirir; gözden geçirme listesi (`node eval/review.ts` → `eval/data/review.md`) de aynısını yapar.

**İlk tam koşu (2026-10-26, ilk yapılandırma: dar desen, 24 saat, ≤800 satır).** 113 aday incelendi ve maliyet pilot dahil $19,06 oldu. Bu tahminin üstünde, çünkü girdinin yalnızca %41'i cache'ten okundu. Sonuç:

- 15 aday kabul edildi: 3 tanesi ≤200, 12 tanesi 201–800 satır.
- Tekilleştirildikten sonra 17 bug.
- Null dönen ajan yok.

Kayıp esas olarak SZZ'nin yanlış PR'ı göstermesinden geliyor: incelenen 242 fix'ten 132'si gerçek bir kusur sayıldı, ama yalnızca 27'sinde kusur bu PR'a aitti.

15, hedeflenen 20 + 3'ün altında kalıyor; ≤200 satırlık hedef 8'in ise yalnızca 3'ü karşılanıyor. Kaldıraçlar ölçüldü (API'siz, `eval/mine.ts` ile):

| Kaldıraç | Yeni aday | Not |
|---|---:|---|
| Daha geniş fix deseni (`--fix-pattern broad`, desen `eval/mine.ts` `FIX_PATTERNS` içinde): "fix" kelimesi geçmeyen düzeltmeler, ör. "Stop the credit balance refresh from logging a 406" | 11 | 89 fix commit'i daha |
| Aynı gün gelen hotfix'ler (`--min-gap-days 0`) | 3 | spec'in "hotfix commit'leri" ifadesiyle uyumlu |
| İkisi birlikte | 17 yeni, 26 adayın fix listesi değişir | eleme ~$7 |
| 801–2000 satır (karar 5'i değiştirir) | 33 | hücre maliyeti büyür |

Kabul oranı %13 ile kapsam içindeki iki kaldıraç yaklaşık 3 bug daha getirir. İkinci bir repo seçenek değil: kullanıcının diğer reponlarında hiç ya da en fazla 7 kapanmış PR var.

**Karar (2026-10-26).** Üç kaldıraç birlikte uygulandı: geniş desen, aynı gün hotfix'ler ve 801–2000 satır (bölüm 9, karar 5). Pilot ayrıca 3 ayrılmış bug'lı PR yerine ters-fix `2a877f1a` ve 2 temiz PR üzerinde koşar; bu, ihtiyacı 23'ten 20'ye indirir. Pilot B'yi ayarlamaz, yalnızca hattı ve maliyeti ölçer; bu yüzden etiketli setten PR ayırmak gerekmez.

**Genişletilmiş koşu (2026-10-26).** Yeni yapılandırmayla 173 aday çıktı:

- 60'ı yeni (43'ü 801–2000 satır),
- 26'sının fix listesi değişti,
- 87'si aynı kaldı.

Eleme ilk koşudan resume edildi. Değişmeyen 87 aday journal'dan geldi; journal 113 satırdan 199'a çıktı, yani tam 86 ajan canlı koştu. Bu tur $20,30 tuttu; elemenin toplamı iki tur ve pilot dahil $39,36.

Sonuç: 30 aday kabul edildi (4'ü ≤200, 17'si 201–800, 9'u 801–2000 satır) ve tekilleştirildikten sonra 41 bug var. Null dönen ajan yok.

**Eleme gürültülüdür.** Yeniden sorulan 26 adaydan, ilk turda kabul edilmiş 2'si (lula-226 ve lula-94) bu turda reddedildi. lula-226 elle kontrol edildi ve ilk tur haklıydı: PR diff'i hem `status === 404 || status === 422` koşulunu hem de her 4xx'i kesin hata sayan `isTerminalResultError`'ı ekliyor. Yani eleme gerçek adayları kaçırabilir. Gözden geçirme listesi bu yüzden önceki turda kabul edilip bu turda reddedilenleri, önceki turun kararıyla ayrı bir bölümde gösterir (`node eval/review.ts --earlier eval/data/triage.v1.json`).

Ters-fix hücresi sızıntısız olmalı, bu yüzden özel kurulur. `2a877f1a`'da kurulan bir repo fix'in mesajını taşır; `2a877f1a^1`'de kurulan bir repoda ise fix commit'i yoktur, yani `git diff 2a877f1a 2a877f1a^1` çalışmaz. Kurulum:

1. Hücre `2a877f1a^1`'de kurulur. Bu bug'lı koddur.
2. Fix'in patch'i nötr mesajlı bir commit olarak uygulanır (`B'`): düzeltilmiş kod.
3. Ters patch ikinci bir nötr commit olarak uygulanır (`H'`): yeniden bug'lı kod.
4. diffRef `B' H'` olur ve çalışma ağacı `H'`'de durur.

Böylece ajan, PR'ı kontrolleri kaldıran bir değişiklik olarak görür; fix'in mesajı ve sonraki geçmiş hücrede yoktur.

### 2.3 Onay

Plan, kullanıcının adayları `eval/data/review.md`'deki sırayla gözden geçirmesiydi. Listede 32 aday var: elemeden geçen 30 aday ve önceki turda kabul edilip bu turda reddedilen 2 aday. Kullanıcı bu onayı yapmadı (karar 8). Onun yerine her aday bir doğrulama ajanından geçer (`eval/workflows/verify.js`, `eval/verify.js`, Opus 5.5 `high`):

- Ajan elemenin gerekçesini görmez, yalnızca iddiayı: dosya, satır, tanım, senaryo ve fix SHA'sı. Böylece iddiayı üreten modelin akıl yürütmesine yaslanmaz.
- Her bug'ı çürütmeye çalışır ve dört soruyu kodu okuyarak cevaplar: kusur merge anında var mı, PR mı getirdi, fix onu düzeltiyor mu, diff'ten görülür mü.
- Dördüne de evet denen bug kalır, ajanın düzelttiği konum ve tanımla. Hiç bug'ı kalmayan aday reddedilir.
- Emin olmayan ajan hayır der. 32 adaydan 20'si gerektiği için yanlış bir red ucuzdur, yanlış bir kabul pahalıdır.
- Ajanın null dönmesi altyapı hatasıdır: aday kararsız kalır ve yeniden koşulur.

Seçim, sıra ve kayıt insan onayı için kurulduğu gibi kaldı:

- **Etiket bug başınadır, PR başına değil.** #546'da iki bug vardı.
- **Seçim:** 20 PR. Önce onaylanan ≤200 satırlık PR'ların hepsi alınır, sonra 201–800 satırlıklar, 20'ye yetmezse 801–2000 satırlıklar. Büyük PR'lar B'nin hücre maliyetini büyüttüğü için en sona kalır. 2000 satır üstü PR'lar kapsam dışıdır ve bu sınır raporda yazılır.
- **Sıra:** `eval/review.ts` üretir. ≤200 grubu satır sayısına göre dizilir, çünkü onaylananların hepsi alınır. 201–800 ve 801–2000 grupları 20261026 tohumuyla ayrı ayrı karıştırılır (mulberry32 ile Fisher–Yates). Sırayla ilerleyip ilk 20 kabulü almak, gruptan sabit tohumla rastgele seçmekle aynıdır ve sonraki adaylara hiç bakılmaz. Kesinleşen sırada 1–5 ≤200, 6–23 201–800, 24–32 801–2000 satırlıktır.
- **Kayıt:** kararlar `eval/data/labels.json`'a yazılır. Dosya bir kez, kararlar boş (`decision: null`) olarak oluşur ve yeniden üretilmez. Kararları `eval/verify.js` yazar; doğrulamanın gerekçesi `note` alanına, tam çıktısı `eval/data/verify.json`'a gider. Önceden yazılmış bir karara dokunmaz, yani bir kararı elle değiştirmek her zaman mümkündür. `node eval/review.ts --earlier eval/data/triage.v1.json` ilerlemeyi ve sıradaki adayı gösterir. Karar verilmemiş ilk adayda durur, çünkü set o adaya kadar belli değildir. 20 kabulde seti bölüm 2.5'teki biçimde `eval/data/set.json`'a yazar. Eleme yeniden koşar ve sıra değişirse set yazılmaz.
- **Pilot setten PR almaz:** ters-fix ve 2 temiz PR üzerinde koşar (bölüm 5).

**Sonuç (2026-10-26).** 1–25. sıradaki adaylar doğrulandı, maliyet $8,60. Run'lar: `20261026-182346-2e1e6d`, `20261026-182447-027884` ve `20261026-182624-399d3f`.

- **Kararlar:** 25 adayın 31 iddiasından 24'ü doğrulandı. 20 aday kabul, 5 aday red.
- **Red gerekçeleri:** lula-324, lula-326 ve lula-94'te kusur yok. lula-110'da fix bu kusuru düzeltmiyor. lula-225'teki kusur PR'dan önce de vardı.
- **Set:** 20. kabul 24. sıradaki lula-262'dir (1.882 satır). lula-225 ondan sonra geldiği için sete etkisi yoktur. Setin boyut dağılımı 4 ≤200, 15 201–800, 1 801–2000 satırdır. 20 bug'lı PR'da 24 bug var.
- **Düzeltilen etiketler:** Kabul edilen 7 adayda doğrulayıcı bir bug'ın satırını, tanımını ya da senaryosunu düzeltti: lula-479, lula-226, lula-273, lula-210, lula-83065cc7b, lula-147, lula-74.
- **Önceki turda kabul, bu turda red alan iki aday:** lula-226 doğrulandı, lula-94 reddedildi.
- **Bug'ların ağırlığı karışıktır.** Derleme hataları (lula-de161bc3d, lula-132, lula-83065cc7b) ve yanlış metinler gibi küçük kusurlar var. Yetkisiz veri erişimi gibi ciddi olanlar da var (lula-71, lula-234).

### 2.4 Temiz PR'lar

Bir PR şu dört koşulu sağlıyorsa temizdir:

- `lula-version`'ın ucundan en az 90 gün önce merge edilmiş,
- hiçbir bağlantı türüyle bir fix'e bağlanmamış,
- eklediği satırlar ya hâlâ uçta duruyor ya da fix olmayan bir commit tarafından kaldırılmış,
- boyut dağılımı, kesinleşen bug setininkine benziyor.

Kesinleşen yapılandırmayla havuzda 56 PR var: 45'i ≤200, 10'u 201–800, 1'i 801–2000 satır. Set için 5 temiz PR, pilot için bunlardan ayrı 2 temiz PR seçilir. Kullanıcı onayı yapılmaz (karar 8).

Seçimi `eval/review.ts` set yazılırken yapar:

- **Gruplara bölme:** önce setin 5'i, sonra pilotun 2'si bug setinin boyut dağılımına göre gruplara bölünür (en büyük kalan yöntemi). Grup içinde hayatta kalması en yüksek PR önce gelir; eşitlik 20261026 tohumuyla bozulur.
- **Boş PR seçilmez:** sayılan hiç satır eklememiş bir PR, örneğin 0/0 olan lula-90, kollara incelenecek bir şey bırakmaz.
- **Hayatta kalma tavanı:** değer 1'de kesilir, çünkü uçtaki blame bir PR'a eklediğinden birkaç satır fazlasını yazabiliyor.

Sonuç: set için lula-311 (19 satır), lula-366 (353), lula-360 (659), lula-298 (439) ve lula-274 (443). Pilot için lula-252 (213) ve lula-f82693144 (509). lula-f82693144, `lula-version`'ın kendisine yapılmış bir merge'üdür, yani tek bir PR değil, uzak dalda biriken bir değişiklik grubudur. Bir kol temiz bir PR'da gerçek bir bug bulursa bu yanlış pozitif sayılmaz (bölüm 6).

### 2.5 Kayıt biçimi

```json
{
  "id": "lula-546",
  "repo": "lula",
  "merge": "<M sha>",
  "base": "<base sha>",
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

Temiz PR'lar aynı biçimde, `kind: "clean"` ve boş `bugs` ile yazılır. Set (20 bug'lı ve 5 temiz PR) `eval/data/set.json`'da, pilotun temiz PR'ları `eval/data/pilot.json`'dadır.

Etiketler private lula kodunu anlatır. Bu yüzden araçlar maestro'da, veriler git'e girmeyen `eval/data/` altında durur.

## 3. Sızıntı önlemleri

**Taze repo.** Her PR şöyle kurulur:

```bash
git init -q <cell> && git -C <cell> fetch -q --no-tags <lula> <M> && git -C <cell> checkout -q --detach <M> && rm <cell>/.git/FETCH_HEAD
```

Kodda bu adım `eval/materialize.ts`'tir. Bu repoda remote yoktur ve yalnızca `M`'nin ataları bulunur. Komut PR #546'nın merge commit'iyle (`7964fab`) denendi. Sonuç: `git log --all` yalnızca `M`'ye kadar gidiyor, `git cat-file -t 2a877f1a` "Not a valid object name" veriyor, `.git` altında ne ref ne remote ne de lula'nın yolu kalıyor. lula'ya hiçbir şey yazılmıyor. Gerekçe: salt-okur bash `git log --all` ve `git show <sha>` çalıştırmaya izin verir. lula'nın bir worktree'si, nesne deposunu paylaştığı için gelecekteki fix'i gösterir.

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

**Pilot.** Ters-fix `2a877f1a` (kurulumu bölüm 2.2) ve setin dışındaki 2 temiz PR (lula-252 ve lula-f82693144, bölüm 2.4) × 2 kol × 1 tekrar. Hücre başına gerçek doları ve duvar saatini ölçer. Hakemi ve trace denetimini sınar; ters-fix'in etiketi kesin olduğu için hakemin eşleştirmesi doğrudan kontrol edilir. Tahmini maliyet yaklaşık $15. Pilot 801–2000 satırlık bir PR içermez, bu yüzden büyük PR'lardaki B maliyeti ilk tam koşu tekrarında ölçülür.

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
| Eleme | 173 | $39,36 | ölçüldü: iki tur ve pilot dahil, Sonnet `medium` |
| Doğrulama | 25 | $8,60 | ölçüldü: Opus 5.5 `high` (bölüm 2.3) |
| Pilot | 6 + hakem | ~$15 | B ölçümü |
| B | 75 | $190–270 | ölçülen $2,55–3,56, 343 satırlık diff; 801–2000 satırlık PR'larda daha pahalı, ölçülmedi |
| A | 75 | $15–40 | tahmin, pilot ölçer |
| Hakem | 150 | pilot ölçer | Opus |

Toplamın kabaca $250–400 olması beklenir. Opus kollarda seçilirse pilot yeniden fiyatlar. Duvar saati henüz ölçülmedi, onu da pilot ölçer.

Kullanıcının zamanı: etiket onayı yok (karar 8), hakem kontrolü için 1–2 saat.

## 8. Dosyalar ve sıra

| Dosya | İş |
|---|---|
| `eval/mine.ts` | SZZ ve üç bağlantı türü → `eval/data/candidates.json` (yazıldı) |
| `eval/workflows/triage.js`, `eval/triage.js` | aday başına eleme ajanı ve çalıştırıcısı → `eval/data/triage.json` (yazıldı) |
| `eval/materialize.ts` | tek commit'i ve atalarını taşıyan taze repo (bölüm 3) (yazıldı) |
| `eval/review.ts` | onay listesi ve sırası → `eval/data/review.md`; kararlar `eval/data/labels.json`'dan → `eval/data/set.json` (yazıldı) |
| `eval/workflows/verify.js`, `eval/verify.js` | aday başına doğrulama ajanı ve çalıştırıcısı → `eval/data/verify.json`, kararlar `eval/data/labels.json`'a (yazıldı) |
| `eval/prepare.js` | hücre repolarını kurar, CLAUDE.md'yi yol için tarar (yazılmadı) |
| `eval/workflows/single-review.js` | A kolu (yazılmadı) |
| `eval/run.js` | 150 hücreyi koşar, `results.jsonl`'a yazar, trace'leri denetler (yazılmadı) |
| `eval/workflows/judge.js` | hakem (yazılmadı) |
| `eval/report.js` | metrikler, eşleştirilmiş tablo, karar (yazılmadı) |

`eval/data/` `.gitignore`'dadır. Hiçbiri pakete (`files`) girmez.

**Durum (2026-11-14):** set hazırlığı (madencilik, eleme, doğrulama, set seçimi) yazıldı ve koştu. Kolları koşturan, puanlayan ve raporlayan beş dosya henüz yazılmadı; bölüm 3-6 onları planlandığı haliyle anlatır, A/B'nin kendisi daha koşmadı.

Sıra:

1. Madencilik ve eleme (yapıldı, $39,36).
2. Etiket onayı: Opus ile doğrulama ve temiz PR seçimi (yapıldı, $8,60; karar 8).
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
5. **Kapsam:** 2000 satır üstü PR'lar dışarıda kalır. İlk karar 800'dü; aynı gün 2000'e genişletildi, çünkü ≤800 ile elemeden yalnızca 15 aday geçti ve onaydan sonra set 20'nin hayli altında kalacaktı (bölüm 2.2). Tek bilinen örneğimiz #546 (yaklaşık 4.150 satır) yine sete girmez; rapor bunu kapsam sınırı olarak yazar.
6. **Madencilik:** geniş fix deseni ve aynı gün hotfix'ler (bölüm 2.1, 2.2).
7. **Pilot:** ters-fix `2a877f1a` ve setin dışındaki 2 temiz PR (bölüm 5).
8. **Etiket onayı:** insan yerine Opus 5.5 `high` ile doğrulama (bölüm 2.3), çünkü kullanıcı adayları okumaya zaman ayıramadı. Etiketler böylece iki modelin süzgecinden geçer: eleme Sonnet, doğrulama Opus. Rapor bunu sınır olarak yazar. Hakem de Opus'tur, ama hakemin işi bulguyu etiketle eşleştirmektir, etiketin doğruluğuna karar vermek değil.
