# Workflow Orchestrator: Tasarım ve Spec

> Çok-ajanlı orkestrasyon katmanı. Dört seviye: tek sayfa, sözleşmeler, mimari, bileşen spec'leri. Sonunda kalıp kütüphanesi, eval planı ve açık sorular.
> Durum: taslak v0.3.1, 2026-10-25. Seviye 0-2 tam, Seviye 3 iki bileşen dolu, Seviye 4 iki örnek script.
> v0.1 → v0.2 (review sonrası): journal anahtarı içerik adresli oldu, bütçeye giriş rezervasyonu ve tur içi abort geldi, izolasyon olmadan yazma aracı yok, semaforun ne zaman slot tuttuğu yazıldı, vm notu, blob eşiği, worktree gc, `meta.maxAgents`, koordinatör merge kalıbı, ADR-4.
> v0.2 → v0.3: `vm` içinde `Date`/`Math` ezme kodu, yazan ajanın el ürünü branch (worktree yolu veya diff metni değil), Journal `get` yalnızca `ok` kayıtları döner.
> v0.3 → v0.3.1: yazan ajanın branch'ini runtime açar (`git worktree add -B`), çıkış doğrulaması runtime'da, `branchName` şemadan çıktı.

---

## Seviye 0: Tek sayfa

**Problem.** Tek bir ajan iki şeyde zorlanır. Birincisi hacim: 400 dosyalık bir audit veya 60 çağrı noktasına dokunan bir migration tek context'e sığmaz, sığsa da kalite sona doğru düşer. İkincisi kendini doğrulama: bir hipotez kuran ajan onu çürütmekte kötüdür. "Burada bug var" diyen ajan aynı turda "aslında yokmuş" demeye meyilli değildir.

**Tez.** Kontrol akışı kodda, muhakeme ajanda. Deterministik bir script, her biri temiz context'le başlayan ajanları çağırır, sonuçlarını birleştirir, oylatır, tekrar dağıtır. Script'i ana ajan yazar, çalıştıran ise LLM değil düz bir JavaScript runtime'ıdır. Böylece "3 skeptik çağır, 2'si çürütürse at" gibi kurallar modelin keyfine değil koda bağlıdır.

**Tek primitive.** `agent(prompt, opts) → Promise<value | null>`. Temiz context, araç listesi, isteğe bağlı JSON schema. Geri kalan her şey (paralel, pipeline, döngü, oylama) bunun kompozisyonudur ve runtime'a değil script'e aittir.

**Non-goals.** Ajanlar birbirini görmez, aralarında mesajlaşma yoktur. Paylaşılan hafıza yoktur, veri script üzerinden akar. İç içe workflow en fazla bir seviye. Sandbox'lı script çalıştırma v1'de yok. Ajan başına UI yok, ilerleme ağacı yeter.

**Başarı ölçütü.** Sabit 20 PR'lık bir set üzerinde "review-changes" workflow'u, aynı modelle tek ajanlı review'a göre yanlış pozitif oranını yarıya indirir ve gerçek bug yakalama oranını düşürmez. Ölçüm Seviye 4'teki eval planıyla yapılır. Bu sayı tutmuyorsa default-on konuşulmaz.

---

## Seviye 1: Kavramlar ve sözleşmeler

### Host API (script'in gördüğü yüzey)

```ts
agent(prompt: string, opts?: {
  label?: string;          // ilerleme ağacındaki ad
  phase?: string;          // ilerleme grubu; aynı string = aynı kutu
  schema?: JSONSchema;     // verilirse doğrulanmış obje döner, yoksa final metin
  model?: string;          // varsayılan: ana oturumun modeli
  effort?: 'low'|'medium'|'high'|'xhigh'|'max';
  isolation?: 'worktree';  // yazan ajanlar için ayrı git worktree
  tools?: string[];        // izinli araç adları; varsayılan salt-okur set
}): Promise<any | null>

parallel(thunks: Array<() => Promise<any>>): Promise<Array<any | null>>
pipeline(items: any[], ...stages: Array<(prev, item, index) => Promise<any>>): Promise<Array<any | null>>
phase(title: string): void
log(message: string): void
args: any                  // tool çağrısından gelen parametre, aynen
budget: { total: number | null; spent(): number; remaining(): number }
```

### Meta bloğu

Her script `export const meta = {...}` ile başlar ve saf literal'dir (değişken, çağrı, spread yok):

```ts
export const meta = {
  name: string;            // kayıtlı workflow adı
  description: string;     // izin diyaloğunda gösterilir
  phases?: Array<{ title: string; detail?: string }>;
  maxAgents?: number;      // bu run için sert ajan tavanı; yoksa global tavan (1000)
}
```

`maxAgents` prompt'taki "10 ajan altı kal" gibi yumuşak kuralların yerine geçer. Döngü kuran script'ler yumuşak kurala sadık kalmaz, tavan koda ait.

### Null ve throw tablosu

Bu tablo en çok tartışılacak yer, o yüzden baştan sabit.

| Durum | Sonuç |
|---|---|
| Ajan terminal API hatasıyla ölür (retry sonrası) | `agent()` **null** döner |
| Kullanıcı ajanı canlı atlar | `agent()` **null** döner |
| Schema sağlanamaz (kök object değil, required ⊆ properties değil) | `agent()` **anında throw** |
| Bütçe aşıldı (giriş rezervasyonu dahil) | `agent()` **throw** |
| Bütçe ajan koşarken aşıldı | AbortSignal tetiklenir, ajan **null**, status `skipped` |
| `meta.maxAgents` veya global ajan tavanı doldu | `agent()` **throw** |
| `parallel` içindeki thunk throw eder | o slot **null**, çağrı reject etmez |
| `pipeline` aşaması throw eder | o öğe **null**, kalan aşamaları atlanır; null dönen aşama normal değer sayılır ve sonraki aşamaya geçer |
| Script'in kendisi throw eder | tüm run **ölür**, tool hata döner |
| Kullanıcı run'ı durdurur | script **reject**, journal kalır |

Kural: ajan seviyesinde hata sessizce null'a düşer, script seviyesinde hata gürültülüdür. Script yazan `.filter(Boolean)` yapar ve kaç öğe düştüğünü `log()` ile söyler.

### Determinizm kuralı

Script içinde `Date.now()`, `Math.random()`, argümansız `new Date()`, dosya sistemi ve ağ erişimi **yok**, çağrı throw eder. Sebep: resume cache anahtarı prompt ve opts hash'inden türer. Prompt her çalışmada değişirse cache hiç tutmaz. Zaman damgası `args` ile dışarıdan verilir, rastgelelik yerine index'e göre prompt varyasyonu kullanılır.

### Dönüş sözleşmesi

Ajanın final metni bir insana mesaj değil, çağıranın kullanacağı ham veridir. System prompt'a yazılır: "Son mesajın bu çağrının dönüş değeridir. Açıklama, selamlama, özet ekleme." Schema verilince bu sorun kalkar, zaten obje döner.

---

## Seviye 2: Mimari

Dokuz bileşen, tek yönlü akış. Policy ve Tool yüzeyi runtime çekirdeğinin dışında durur; Seviye 3 içteki yedisini spec'ler. Politika üstte prompt'a enjekte olur, tool çağrısı script'i runtime'a verir, runtime scheduler üzerinden runner'ı çağırır, runner SDK'ya gider. Journal, budget ve isolation yan hizmetlerdir.

```
Policy (system prompt'a enjekte) ─┐
                                  ▼
Tool yüzeyi (Workflow) ─▶ Script runtime ─▶ Scheduler ─▶ Agent runner ─▶ Anthropic SDK
                                │               │              │
                                ▼               ▼              ▼
                            Journal          Budget        Isolation
                                └──────▶ Observability ◀──────┘
```

| Bileşen | Sorumluluk | Neden ayrı |
|---|---|---|
| **Policy** | Opt-in / default-on kuralını ve "ne zaman workflow" sezgisini ana ajanın prompt'una yazar; ölçek tavanı ise `meta.maxAgents` ve global tavanla koddadır | Yetenek sabit, politika config. Aynı tool'u "sadece istenince" veya "her ciddi işte" moduna metin değiştirerek alırsın; sayısal sınırlar prompt'a değil koda ait |
| **Tool yüzeyi** | `script \| name \| scriptPath`, `args`, `resumeFromRunId` alır; hemen runId döner; sonuç bildirimle gelir | Ana ajan 20 dakika kilitlenmesin, konuşmaya devam edebilsin |
| **Script runtime** | Host API'yi script'e enjekte eder, `meta` bloğunu okur, yasaklı globalleri throw eden stub'larla değiştirir | Script'in gördüğü dünya dar olmalı; genişletmek kolay, daraltmak zor |
| **Scheduler** | Semafor (min(16, CPU-2)), ömür boyu ajan tavanı (1000), iptal sinyali. Slot yalnızca canlı SDK çağrısı sürerken tutulur | Runner'dan ayrılmazsa iç içe workflow'da kota paylaşımı yapılamaz |
| **Agent runner** | Tek ajanı koşturur: araç döngüsü, structured output, retry, token sayımı | SDK değişince sadece burası değişir |
| **Journal** | Her `agent()` çağrısını (içerik hash'i + kaçıncı tekrar, sonuç) jsonl'e yazar; resume'da içerik adresli replay eder | Tekrar çalıştırma maliyeti olmadan script düzenlemek ancak böyle mümkün |
| **Budget** | Output token sayacı; girişte rezervasyonlu kontrol, tur içinde güncelleme, aşımda abort | Kaçak döngünün tek güvenilir freni |
| **Isolation** | `worktree` için `git worktree add` (mutex'li), temizse siler, kirliyse bırakır; izolasyon yoksa yazma araçları verilmez | Paralel yazan ajanlar aynı dosyaya dokunursa birbirini ezer |
| **Observability** | Phase grupları, label'lar, log satırları, canlı ağaç | 30 ajanlık koşu kara kutu olmasın |

### Veri akışı, tek `agent()` çağrısı

1. Script `agent(p, o)` çağırır. Runtime içerik hash'i üretir: `h = hash(p, canonical(o \ {label, phase}))`, sonra bu run'da `h`'nin kaçıncı çağrısı olduğunu sayar: `key = h + ':' + n`. Çağrı sırası anahtara girmez.
2. Journal'da `key` varsa sonuç anında döner, scheduler'a gidilmez.
3. Yoksa `meta.maxAgents` ve global tavan kontrol edilir; sonra budget: `spent() + rezervasyon > total` ise throw. Rezervasyon, tamamlanan ajanların hareketli ortalaması, tabanı 5k token.
4. `o.isolation` yoksa araç listesinden yazma araçları çıkarılır. Varsa Isolation mutex altında worktree açar.
5. Scheduler slot verir (semafor). Slot yalnızca SDK çağrısı sürerken tutulur.
6. Runner ajanı koşturur. Her tur sonunda `usage.output_tokens` budget'a eklenir; `spent() > total` olursa AbortSignal tetiklenir, ajan null döner.
7. Sonuç (veya null) journal'a yazılır, sonra script'e döner. Yazma önce, dönüş sonra; aksi halde kesinti sonrası tekrar koşar.

---

## Seviye 3: Bileşen spec'leri

Sabit format: sorumluluk, arayüz, değişmezler, hata halleri, testler. İki bileşen dolu, diğerleri iskelet.

### 3.1 Journal

**Sorumluluk.** Her ajan çağrısının girdisini ve çıktısını kalıcı tutmak; resume'da değişmeyen prefix'i cache'den karşılamak.

**Arayüz.**
```ts
interface Journal {
  get(key: string): Entry | undefined;
  append(entry: Entry): Promise<void>;     // fsync'li append
}
interface Entry {
  index: number;            // çağrı sırası, yalnızca görüntü ve ayıklama için; anahtara girmez
  hash: string;             // sha256(prompt + "\n" + canonicalJSON(opts without label/phase))
  n: number;                // bu hash'in bu run'daki kaçıncı çağrısı, 0'dan
  key: string;              // hash + ":" + n
  label?: string;
  result: any | null;       // schema'lı ise doğrulanmış obje
  usage: { output_tokens: number; input_tokens: number };
  status: 'ok' | 'null' | 'skipped';   // yalnızca 'ok' cache isabetidir
}
```
Dosya: `<run-dir>/journal.jsonl`, satır başına bir Entry. Ayrıca `<run-dir>/script.js` ve `<run-dir>/args.json`; resume bunları okur.

**Değişmezler.**
- Anahtar **içerik adreslidir, sıra adresli değil**. Paralel dallarda `agent()`'a kimin önce ulaşacağı önceki ajanların bitiş süresine bağlıdır; resume'da cache'den 0 ms'de dönen bir dal sırayı değiştirir. Sıra anahtara girseydi tek bir kayma tüm cache'i yakardı.
- Aynı içerikli tekrar çağrılar `n` ile ayrılır. `while` döngüsünde ikinci tur `n=1` alır, ilk turun sonucunu almaz. Paralel iki dal aynı hash'i üretirse `n`'leri yer değiştirebilir; girdileri birebir aynı olduğu için sonuçları da birbirinin yerine geçer.
- `label` ve `phase` hash dışıdır; yalnızca görüntü içindir, değişmeleri cache'i bozmaz.
- `canonicalJSON` anahtarları sıralar. Opts'ta `{a,b}` ile `{b,a}` aynı hash'tir.
- Resume'da isabet çağrı başına bakılır. Script'in ortasındaki bir çağrı değişirse yalnızca o çağrı ve prompt'u onun sonucundan türeyen çağrılar canlı koşar; bağımsız kardeşler cache'den gelir.
- Append sonuç döndürülmeden önce tamamlanır.
- **`get(key)` yalnızca `status === 'ok'` kaydı döner.** `null` (API hatası) ve `skipped` (bütçe veya kullanıcı atlaması) kayıtlar denetim ve log içindir, cache isabeti sayılmaz; resume'da o çağrı tekrar koşar. Bütçe artırılıp (`+500k`) resume edildiğinde yarıda kalan ajanların canlanması bu kuralla olur. Aynı `key` için birden fazla satır olabilir, `get` en son `ok` olanı döner.
- 64 KB üstü `result`, `<run-dir>/blobs/<key>.json` dosyasına yazılır; satırda `{ blob: "<key>" }` referansı durur. Altı doğrudan satıra gömülür.

**Hata halleri.**
- Journal yazılamıyorsa run başlamaz. Yarı kayıtlı run resume edilemez olur, bu kabul edilemez.
- Bozuk satır (yarım JSON) görülürse o satır ve sonrası yok sayılır, log'a yazılır.
- Prompt'u değişen çağrı cache'i ıskalar, canlı koşar. Doğru davranış bu, sessiz yanlış cache daha kötü.
- Blob dosyası kayıpsa satır `null` sayılır ve log'a yazılır; run devam eder.

**Testler.**
- Aynı script + aynı args ikinci koşu: sıfır ajan çağrısı, aynı dönüş değeri.
- Script'in 3. `agent()` çağrısının prompt'u değişti: 3 canlı, ondan bağımsız 4 ve 5 cache'den, 3'ün sonucunu prompt'una alan 6 canlı.
- Döngüde aynı prompt 5 kez: aynı hash, `n` 0..4, 5 ayrı Entry.
- `parallel` içinde 4 dal, ilk koşuda bitiş sırası A,C,B,D; resume'da hepsi cache'den ve sıra A,B,C,D: sıfır canlı çağrı.
- 200 KB sonuç: satırda blob referansı, `blobs/` altında dosya, `get()` birleştirip döner.
- Bütçe 100k ile 10 ajanın 6'sı `ok`, 4'ü `skipped`; bütçe 300k ile resume: 6 cache, 4 canlı, journal'da 14 satır.
- API hatasıyla `null` dönen ajan, resume'da tekrar koşar ve `ok` olursa `get` yeni kaydı döner.
- Yazma sırasında process öldürüldü: resume son tam satırdan devam eder.

### 3.2 Agent runner

**Sorumluluk.** Tek bir ajanı baştan sona koşturmak: araç döngüsü, final cevabı şemaya zorlamak, retry, token ölçümü.

**Arayüz.**
```ts
interface AgentRunner {
  run(req: {
    prompt: string;
    system: string;                   // dönüş sözleşmesi + proje CLAUDE.md
    tools: ToolDef[];                 // salt-okur varsayılan: read, grep, glob, bash(ro)
    schema?: JSONSchema;
    model: string;
    effort: Effort;
    cwd: string;                      // isolation worktree ise onun yolu
    signal: AbortSignal;
  }): Promise<{ result: any | null; usage: Usage; turns: number }>;
}
```

**İki aşamalı koşu.** Ajan önce araçlarla çalışır, sonra tek bir yapılandırılmış cevap verir.

1. **Araç döngüsü.** SDK'nın tool runner'ı: `client.beta.messages.toolRunner({...})` ile `betaZodTool` tanımlı araçlar. Döngü `end_turn` ile biter. `max_tokens` ve tur sayısı sınırlıdır (varsayılan 40 tur).
2. **Yapılandırılmış final.** `schema` verilmişse aynı transcript'e bir kullanıcı mesajı eklenir ("Bulgularını şemaya göre döndür") ve `client.messages.parse({ output_config: { format: zodOutputFormat(schema) } })` çağrılır. `parsed_output` null ise bir kez daha denenir, sonra ajan null sayılır.

**Neden iki aşama.** Güncel modellerde (Opus 5.5, Sonnet 5.5, Fable 5.1) `tool_choice: any/tool` ile araç zorlamak 400 döner. Eski "StructuredOutput adlı tool'u zorla" numarası artık çalışmaz. Structured output API'nin kendi özelliği olduğundan son adımı oraya bırakmak hem garantili hem ucuz. Araçlar ve `output_config.format` aynı istekte birlikte çalışıyorsa tek aşamaya indirilebilir; bu, uygulamadan önce SDK dokümanından doğrulanacak.

**Alternatif binding: Claude Agent SDK.** Ajanların dosya sistemi, bash ve grep'e hazır araçlarla erişmesi isteniyorsa runner'ın ikinci implementasyonu Agent SDK'nın `query()` fonksiyonu olabilir. Parametre adları ve structured output desteği burada yazılmadı, `code.claude.com/docs/en/agent-sdk` üzerinden doğrulanıp eklenecek. Runner bir arayüz olduğu için iki binding yan yana durabilir.

**Değişmezler.**
- `strict: true` olan araç şemaları `additionalProperties: false` ve `required` taşır; model şemaya uymayan input üretemez.
- Her tur sonunda `usage.output_tokens` Budget'a **anında** bildirilir, yalnızca dönüşte değil; Budget aşımı bildirirse runner AbortSignal'i tetikler ve `status: 'skipped'` döner.
- `isolation` yoksa araç listesi salt-okurdur ve bu runner'da zorlanır, script'in `tools` ile yazma aracı istemesi reddedilir.
- Runner içinde alt ajan yoktur. Ajan `agent()` çağıramaz, workflow başlatamaz. Semafor kıtlığının (slot tutan ajanın slot bekleyen çocuğu) tek kaynağı budur ve kapalıdır.
- `stop_reason === 'refusal'` görülürse ajan null sayılır, kategori log'lanır, retry yapılmaz.
- `stop_reason === 'max_tokens'` görülürse bir kez "devam et" ile tekrar denenir.
- Ajan birbirinin çıktısını görmez; sadece script'in prompt'a koyduğu kadarını bilir.

**Hata halleri.**
- 429 ve 5xx: SDK retry (varsayılan 2), sonra bir kez runner seviyesinde bekle-dene, sonra null.
- 400: null, hata metni log'a. Prompt veya şema hatasıdır, tekrar denemek anlamsız.
- Schema parse iki kez başarısız: null, ham metin journal'a `raw` alanında.
- AbortSignal: devam eden istek iptal, `status: 'skipped'`.

**Model ve effort varsayılanları.** Ana oturumun modeli miras alınır. Mekanik aşamalar (dosya listeleme, format dönüştürme) `effort: 'low'`, çürütme ve jüri aşamaları `effort: 'high'` veya üstü. Model seçimini script yapar, runner sorgulamaz.

**Testler.**
- Şemalı ajan, uyumsuz ilk cevap: ikinci denemede doğru obje döner, `turns` 2 artar.
- Araç hatası (dosya yok): `tool_result` `is_error: true` ile döner, ajan devam eder.
- Bütçe aşımı ortada: AbortSignal tetiklenir, ajan skipped.
- 40 tur sonra bitmedi: null, log'da "turn cap".

### 3.3 Script runtime (iskelet)
- Sorumluluk: `meta` literal'ini parse et, host API'yi enjekte et, deterministik olmayan builtin'leri ez.
- Arayüz: `run(scriptSource, args, hooks) → Promise<any>`.
- Çalıştırma: Node `vm.createContext` ile yeni bir context, içine yalnızca `{ agent, parallel, pipeline, phase, log, args, budget, workflow }`. `process`, `require`, `fetch` bu context'te tanımlı değildir. Dikkat: yeni context boş gelmez, kendi `Math`, `Date`, `Promise`, `JSON` builtin'leriyle gelir; `Math.random` ve `Date` yine throw eden sürümlerle **ezilmelidir**.
- Ezme context'in **içinde** yapılır, çünkü yeni context'in `Date` ve `Math` referansları ana context'tenkinden farklıdır; dışarıdan `globalThis.Math.random`'ı değiştirmek script'in gördüğünü etkilemez:

```js
const ctx = vm.createContext({ agent, parallel, pipeline, phase, log, args, budget, workflow })
vm.runInContext(`
  Math.random = () => { throw new Error('determinism: Math.random() yasak') }
  Date = class DetDate extends Date {
    constructor(...a) { if (!a.length) throw new Error('determinism: new Date() yasak'); super(...a) }
    static now() { throw new Error('determinism: Date.now() yasak') }
  }
`, ctx)
```

  Alt sınıf argümanlı kullanıma (`new Date(args.timestamp)`) izin verir, argümansızı ve `Date.now()`'u yakalar; class olduğu için `Date()` şeklinde new'siz çağrı kendiliğinden TypeError verir. Proxy gerekmez.
- `vm` bir güvenlik sınırı değildir (Node dokümanı bunu açıkça söyler). Tehdit modeli düşük, script'i kullanıcının kendi ajanı yazar; bu yüzden "sandbox" değil "dar global" diye adlandırılır. Gerçek izolasyon gerekirse ayrı process veya izole JS runtime v2 işidir.
- Değişmezler: `meta` saf literal olmalı; `phase()` adları `meta.phases` ile birebir eşleşir; `meta.maxAgents` varsa Scheduler'a geçer.
- Hata halleri: syntax hatası run başlamadan döner; `meta` yoksa reddedilir.
- Testler: `Date.now()` ve `new Date()` throw eder, `new Date(args.ts)` çalışır; `Math.random()` throw eder, `Math.floor` çalışır; `process` referansı ReferenceError; `JSON.stringify` çalışır.

### 3.4 Scheduler (iskelet)
- Semafor boyutu `min(16, cpus - 2)`; ömür boyu ajan tavanı `meta.maxAgents ?? 1000`; tek `parallel`/`pipeline` çağrısında 4096 öğe sınırı, aşımı açık hata.
- **Slot yalnızca canlı SDK çağrısı sürerken tutulur.** Script'in kendisi, `parallel`/`pipeline` beklemeleri ve `workflow()` çağrısı slot tutmaz. Üst workflow 16 ajanı doldurup `workflow()` beklese bile o 16 ajan bitince slot boşalır, çünkü hiçbir ajan bir başkasının bitmesini beklemez (3.2: runner içinde alt ajan yok). Bu yüzden klasik thread-pool starvation burada oluşmaz.
- İç içe `workflow()` çağrısı aynı semaforu, aynı ajan sayacını ve aynı bütçeyi paylaşır; alt workflow'un ajanları `/workflows` ağacında "▸ name" grubu altında görünür.
- Testler: 32 ajanlık `parallel`, 16 slot: hiçbir anda 17 canlı istek yok; iç içe workflow'da 16 üst + alt ajanlar: deadlock yok, toplam süre üst sınırla uyumlu.

### 3.5 Budget (iskelet)
- `total` kullanıcı direktifinden ("+500k") gelir, yoksa null ve `remaining()` Infinity.
- `spent()` ana döngü ve tüm workflow'lar arasında paylaşılan tek havuz.
- **Giriş rezervasyonu.** Yalnızca `spent()`'e bakmak yetmez: 16 paralel ajan bütçenin bitmesine 1k token kala girerse bütçeyi 16 kat deler. Girişte `spent() + inflight × reserve > total` ise throw. `reserve` tamamlanan ajanların output token hareketli ortalaması, tabanı 5k; ilk ajanlar için taban kullanılır.
- **Tur içi güncelleme.** Runner her turda `usage.output_tokens` bildirir (3.2). `spent() > total` olduğu anda Budget, kayıtlı tüm AbortSignal'leri tetikler; devam eden ajanlar `skipped` olur, yeni girişler throw eder.
- Aşım payı: tur ortasında tetiklenen abort yine bir turluk token harcar. Kabul edilen üst sınır `total + 16 × max_tokens_per_turn`; bu sayı log'a yazılır.
- Testler: 16 ajan, bütçe 20k, her ajan 5k: en fazla 4 ajan girer, 12'si throw. Koşan ajan bütçeyi tur ortasında aşarsa bir sonraki turda abort.

### 3.6 Isolation (iskelet)
- Salt-okur izolasyon: `git worktree add --detach <tmp> HEAD`. Yazan ajan: `git worktree add -B wf/<runId>/<label> <tmp> HEAD`; branch'i **runtime açar**, ajan o branch'in içinde başlar ve yalnızca `git commit` yapar. Branch adını prompt'tan okumaz, yanlış yazamaz, detached HEAD'de kalamaz. Oluşturma ve silme tek bir mutex altında serileşir; 16 paralel `worktree add` git kilit çekişmesine girmez.
- `-B`, `-b` değil: resume'da `null` veya `skipped` kalmış yazan ajan tekrar koşar ve branch önceki denemeden zaten vardır. `-b` burada hata verir; `-B` branch'i HEAD'e sıfırlar. Önceki deneme `ok` olmadığı için üstüne yazmak kayıp değildir. `ok` olmuş bir ajan journal'dan döner, worktree hiç açılmaz.
- `node_modules` ve build artifact'leri worktree'ye kopyalanmaz; gerekiyorsa ana checkout'tan symlink. Ajan `npm install` çalıştırmaz. Asıl maliyet git değil disk kopyasıdır, bu kural onu sıfırlar.
- `isolation` istenmeyen ajan yazma aracı alamaz (3.2'de zorlanır). Yazan ajan = izole ajan, istisnasız.
- Bitişte `git status` temizse worktree `finally` bloğunda silinir, AbortSignal dahil her çıkış yolunda. Kirli worktree silinmez; yolu ve `git diff --stat` özeti dönüş değerine ve log'a yazılır.
- Kalan kirli worktree'ler `workflow gc` komutuyla listelenir ve toplu silinir; otomatik silme yoktur, yarım kalan iş değerli olabilir.
- **Yazan ajanın el ürünü branch'tir**, worktree yolu veya diff metni değil. Ajan runtime'ın açtığı `wf/<runId>/<label>` branch'ine commit eder ve yalnızca `{ summary, filesTouched }` döndürür; `branchName`'i runtime dönüş değerine ekler, ajan bilmez. Commit sonrası worktree temizdir ve silinir; branch kalır.
- **Çıkış doğrulaması runtime'da.** Ajan bitince üç kontrol: `git rev-parse --abbrev-ref HEAD` beklenen branch mı, `git status --porcelain` boş mu, `git rev-list HEAD ^<base>` en az bir commit veriyor mu. Üçü de tutarsa ajan `ok` ve dönüş değerine `branchName` eklenir. Branch değişmişse veya commit yoksa ajan `null` sayılır (log: "no handoff"); worktree kirliyse kirli lane'e düşer. Ajanın "bitirdim" demesi yetmez, kanıt Git'ten okunur. Worktree yolu döndürülmez, çünkü temizlik kuralı onu siler; diff metni döndürülmez, çünkü 10 ajan × 500 satır koordinatörün context'ini şişirir. Birleştirme script'in işi değildir (Seviye 4, koordinatör merge kalıbı).
- Commit etmeyen yazan ajan kirli worktree bırakır; o `gc` lane'ine düşer ve koordinatöre girmez. Yazan ajanın system prompt'u "bitirince commit et" der.
- Run branch'leri (`wf/<runId>/*`) koordinatör birleştirdikten sonra `workflow gc` ile silinir; birleşmeyenler kalır ve listelenir.
- Testler: 16 paralel izole ajan: 16 worktree, sıralı oluşturma, çekişme hatası yok. Abort edilen temiz ajan: worktree yok. Abort edilen kirli ajan: worktree duruyor, log'da yol.

### 3.7 Observability (iskelet)
- Olay akışı: `agent_start`, `agent_end`, `phase`, `log`, `budget_tick`.
- Tüketici: terminal ağacı, `/workflows` paneli.
- Testler: TBD.

### Karar kayıtları (ADR)

**ADR-1: Orkestrasyonu LLM değil script yapar.**
Karar: fan-out, oylama ve döngü düz JavaScript'tir. Reddedilen alternatif: bir "yönetici ajan"ın alt ajanları araç çağrısıyla yönetmesi. Sebep: yönetici ajan 3 skeptikten 2'sinin çürüttüğü bulguyu "ama bence haklı" diye tutabilir; kodda bu imkânsız. Ayrıca yöneticinin context'i alt ajan çıktılarıyla dolar, tam da kaçınmak istediğimiz şey.

**ADR-2: `pipeline` varsayılan, `parallel` istisna.**
Karar: çok aşamalı işte aşamalar arası bariyer yok. Reddedilen alternatif: her aşama bitince diğerine geçen `parallel` zinciri. Sebep: 5 bulucu koşup en yavaşı en hızlının 3 katı sürüyorsa bariyer hızlıların boş beklediği zamanın üçte ikisini çöpe atar. Bariyer yalnızca aşama N'nin aşama N-1'in **tüm** sonuçlarına ihtiyacı varsa (dedup, erken çıkış, "diğer bulgularla karşılaştır") meşrudur.

**ADR-3: Ajanlar birbirini görmez.**
Karar: ajanlar arası mesaj yok, paylaşılan bellek yok; veri yalnızca script üzerinden akar. Reddedilen alternatif: ortak bir scratchpad veya mesaj kuyruğu. Sebep: bağımsız doğrulamanın değeri bağımsızlıktan gelir. Skeptik, bulucunun gerekçesini okursa onun çerçevesine kayar. Ayrıca determinizm bozulur, journal replay güvenilmez olur.

**ADR-4: Cache anahtarı içerik adresli, sıra adresli değil.**
Karar: `key = hash(prompt, opts) + ":" + n`, `n` aynı hash'in kaçıncı çağrısı. Reddedilen alternatifler: (a) global çağrı sırası `index` anahtarda, "ilk uyuşmazlıktan sonrası canlı" kuralı; (b) çağrı ağacındaki hiyerarşik yol (`stage1.item2.parallel0`). Sebep: (a) paralel dallarda sıra ajan bitiş sürelerine bağlıdır, resume'da cache'den anında dönen bir dal sırayı kaydırır ve bütün cache yanar. (b) `parallel` ve `pipeline` düz fonksiyonlar olduğu için ağaç konumu ancak AsyncLocalStorage ile izlenir, kırılgan ve script yazarının görmediği bir gizli durumdur. İçerik adresli anahtar sıra kaymasına dayanıklıdır ve bir yan kazanç verir: script'in ortasındaki bir çağrıyı değiştirmek ondan bağımsız kardeşlerin cache'ini bozmaz.

---

## Seviye 4: Kalıp kütüphanesi ve eval

### Örnek 1: review-changes (bul → adversarial doğrula → sentezle)

```js
export const meta = {
  name: 'review-changes',
  description: 'Diff\'i üç boyuttan incele, her bulguyu üç skeptikle oyla',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

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

const DIMENSIONS = [
  { key: 'correctness', prompt: `Diff: ${args.diffRef}. Yalnızca mantık hatası ara...` },
  { key: 'security',    prompt: `Diff: ${args.diffRef}. Yalnızca güvenlik...` },
  { key: 'data-loss',   prompt: `Diff: ${args.diffRef}. Veri kaybı ve geri alınamaz işlem...` },
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
```

Dikkat: `Verify` aşaması `Find`'ın tüm sonuçlarını beklemez; correctness boyutu doğrulanırken security hâlâ aranıyor olabilir. Sentez tek bariyerdir çünkü tüm bulgulara birlikte ihtiyaç duyar.

### Örnek 2: loop-until-dry (bilinmeyen boyutlu keşif)

```js
export const meta = {
  name: 'find-edge-cases',
  description: 'İki tur üst üste yeni şey çıkmayana kadar edge case ara',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

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
```

Dikkat: dedup `seen` üzerinden yapılır, `confirmed` üzerinden değil. Aksi halde jürinin reddettiği bulgu her turda yeniden çıkar ve döngü hiç kurumaz.

### Diğer kalıplar (başlık düzeyinde)
- **Judge panel**: N farklı açıdan (MVP-first, risk-first, user-first) tasarım üret, paralel jüriyle puanla, kazanandan sentezle.
- **Multi-modal sweep**: aynı soruyu farklı arama yollarıyla (dosya adı, içerik, sembol, git log) paralel ajanlara ver.
- **Completeness critic**: son ajan "ne eksik: koşulmayan modalite, doğrulanmamış iddia, okunmamış kaynak" diye sorar; bulduğu bir sonraki turun işi olur.
- **No silent caps**: top-N, örnekleme, retry yok gibi sınırlar `log()` ile söylenir.
- **Fan-out writers → coordinator merge**: N izole ajan paralel yazar, her biri kendi branch'ine commit eder ve `{ branchName, summary, filesTouched }` döndürür. Diff metni script'e girmez; koordinatörün prompt'una yalnızca branch adları ve kısa özetler girer, diff'leri koordinatör `git cherry-pick` veya `git diff <branch>` ile kendi okur. Script birleştirmeye kalkmaz; tek bir koordinatör ajan (izole, yazma araçlı) branch'leri sırayla alır, çatışmaları çözer, testleri koşar ve tek bir branch döndürür. Çatışma çözümü muhakeme işidir, deterministik script'e ait değildir.

```js
// Ajan yalnızca summary ve filesTouched verir; branchName'i runtime ekler (3.6).
const WRITE_RESULT = { type: 'object', properties: {
  summary: { type: 'string' },
  filesTouched: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'filesTouched'] }

const branches = (await parallel(TASKS.map(t => () =>
  agent(`${t.brief}. Bitince değişikliklerini commit et; tek paragraf özet ve dokunduğun dosyaları döndür.`,
    { label: t.key, isolation: 'worktree', tools: WRITE_TOOLS, schema: WRITE_RESULT }))))
  .filter(Boolean)   // null = commit yok veya çıkış doğrulaması geçmedi
log(`${branches.length}/${TASKS.length} branch geldi`)

const overlap = branches.flatMap(b => b.filesTouched).filter((f, i, a) => a.indexOf(f) !== i)
if (overlap.length) log(`çakışma adayı dosyalar: ${[...new Set(overlap)].join(', ')}`)

return agent(
  `Şu branch'leri sırayla ana branch'in üstüne cherry-pick et, çatışmaları çöz, testleri koştur, sonuç branch adını döndür. ` +
  `Çakışma adayı dosyalar: ${[...new Set(overlap)].join(', ') || 'yok'}.\n` +
  branches.map(b => `- ${b.branchName}: ${b.summary} (${b.filesTouched.length} dosya)`).join('\n'),
  { label: 'coordinator', isolation: 'worktree', tools: WRITE_TOOLS, schema: WRITE_RESULT, effort: 'high' })
```

  Dikkat: ajan prompt'unda branch adı geçmez; `wf/<runId>/<label>` branch'ini runtime açar ve dönüş değerine `branchName` olarak ekler. Koordinatörün sonucu da aynı yolla `wf/<runId>/coordinator` branch'inde biter. `filesTouched` kesişimi script'te hesaplanır ve koordinatöre ipucu olarak verilir; bu deterministik bir işlemdir ve koordinatörün nereye bakacağını baştan bilmesini sağlar.

### Eval planı
- **Set**: 20 merged PR, her birine sonradan bulunan gerçek bug'lar etiketlenmiş (production incident, hotfix commit'leri). 5 PR temiz kontrol.
- **Kollar**: (A) tek ajan review, aynı model ve effort. (B) review-changes workflow'u, 3 boyut × 3 skeptik.
- **Metrikler**: gerçek bug yakalama oranı, yanlış pozitif sayısı / PR, toplam output token, duvar saati.
- **Karar eşiği**: B'nin yanlış pozitifi A'nın yarısından az ve yakalama oranı A'dan düşük değilse Seviye 0 hedefi tutmuş sayılır. Token maliyeti ayrıca raporlanır, eşiğe girmez.
- **Tekrar**: her kol 3 kez koşar, medyan alınır.

---

## Açık sorular

1. Araçlar ve `output_config.format` aynı istekte birlikte çalışıyor mu? Doğrulanmadı. Çalışsa bile iki aşama tercih: ilk aşamada "araştır", ikincisinde "şemaya dök" diye bilişsel yük ayrılır, model erken JSON'a kaçmaz. İkinci çağrının transcript'i prompt cache'ten gelir, maliyet farkı küçük. Soru yalnızca "tek aşama bir optimizasyon olarak sonra eklenir mi" diye açık.
2. Agent SDK binding'i v2'ye ertelendi. v1 kendi `ToolDef` setini (read, grep, glob, salt-okur bash) runner içinde tutar; token sayımı, abort ve determinizm üzerinde tam kontrol bunu gerektirir.
3. Occurrence counter'da `n` ataması paralel dallarda yer değiştirebilir. Girdiler birebir aynıysa sorun yok; ama `opts.model` veya `effort` farklı olan iki çağrı zaten farklı hash alır. Kalan risk: aynı prompt, aynı opts, farklı `label` ile iki dal. `label` hash dışı olduğu için bunlar da takas edilebilir sayılır. Bu varsayım yanlış çıkarsa `label` hash'e alınır.
4. İzole process veya ayrı JS runtime (gerçek sandbox) ne zaman gerekir? Script'i üçüncü taraf yazabildiği gün. O güne kadar `vm` dar globali yeter.

### v0.2'de kararlaştırılanlar (eski açık sorular)
- Sandbox: `vm.createContext`, boş global değil dar global, `Math.random`/`Date` ezilir; güvenlik sınırı sayılmaz (3.3).
- Journal boyutu: 64 KB üstü `blobs/`, altı satırda (3.1).
- İptal edilen run'ın worktree'leri: temiz olan `finally`'de silinir, kirli olan kalır, `workflow gc` toplar (3.6).
- Ölçek dili: `meta.maxAgents` sert tavan, prompt'a yalnızca "ne zaman workflow" sezgisi (Seviye 1, Policy).
- Merge çatışması: koordinatör ajanda, script'te değil (Seviye 4 kalıbı, 3.6).

### v0.3'te kararlaştırılanlar
- Yazan ajanın el ürünü branch (`wf/<runId>/<label>`); worktree yolu temizlik kuralıyla çakışır, diff metni koordinatör context'ini şişirir (3.6, Seviye 4).
- Journal `get(key)` yalnızca `ok` döner; `null` ve `skipped` resume'da tekrar koşar (3.1).
- `vm` context'inde `Math.random` ve `Date` içeriden, `runInContext` ile ezilir; `Date` alt sınıfı argümanlı kullanıma izin verir (3.3).
- Yazan ajanın branch'ini runtime açar (`git worktree add -B`), ajan yalnızca commit eder; branch adı, temizlik ve commit varlığı çıkışta runtime tarafından Git'ten doğrulanır, `branchName` şemadan çıkıp dönüş değerine eklenir (3.6, Seviye 4).
