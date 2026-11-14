# Maestro

Çok-ajanlı orkestrasyon katmanı. Kontrol akışı kodda, muhakeme ajanda: deterministik bir JavaScript script'i, her biri temiz context'le başlayan ajanları çağırır, sonuçlarını birleştirir, oylatır ve tekrar dağıtır. Script'i ana ajan yazar, çalıştıran LLM değil düz bir runtime'dır.

Tasarım ve sözleşmeler [docs/spec.md](docs/spec.md) içinde (v0.3.2). Spec'in açık bıraktığı noktalarda alınan kararlar [docs/decisions.md](docs/decisions.md) içinde. Script yazmayı modele öğreten skill [skill/SKILL.md](skill/SKILL.md) içinde.

## Kurulum

Node 22.18 veya üstü gerekir (duman testi ve eval çalıştırıcıları `.ts` dosyalarını doğrudan koşturur).

```bash
npm install
```

```bash
npm run build
```

Paket ESM'dir ve tek bağımlılık katmanı Anthropic TypeScript SDK'sıdır (`@anthropic-ai/sdk`), yanında `zod`, `acorn` ve MCP sunucusu için `@modelcontextprotocol/sdk` gelir. Varsayılan Anthropic runner için `ANTHROPIC_API_KEY` ortam değişkeni gerekir; Codex runner kurulu ve giriş yapılmış Codex CLI'ı kullanır. Testler ve `--dry-run` ağa hiç çıkmaz.

Run'lar çalışılan dizinde `.maestro/` altında tutulur (`runs/<runId>/`, `worktrees/`, `workflows/`, `tools/`). Bu dizini kendi reponda `.gitignore`'a ekle.

## İlk script

`review.js`:

```js
export const meta = {
  name: 'quick-review',
  description: "Diff'i iki boyutta incele, her bulguyu iki skeptikle oyla",
  phases: [{ title: 'Find' }, { title: 'Verify' }],
  maxAgents: 40,
}

const FINDINGS = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: {
  type: 'object', required: ['file', 'claim'], properties: { file: { type: 'string' }, claim: { type: 'string' } } } } } }
const VERDICT = { type: 'object', required: ['refuted'], properties: { refuted: { type: 'boolean' } } }

const perDim = await pipeline(
  ['correctness', 'security'],
  d => agent(`git diff ${args.diffRef} değişikliğinde yalnızca ${d} sorunlarını ara.`,
    { label: `find:${d}`, phase: 'Find', schema: FINDINGS }),
  async (found, d) => {
    if (!found) { log(`${d}: bulucu null`); return [] }
    return parallel(found.findings.map(f => async () => {
      const votes = await parallel([0, 1].map(i => () =>
        agent(`Bu iddiayı çürütmeye çalış: ${f.claim} (${f.file}). Emin değilsen refuted=true. Bakış ${i}.`,
          { label: `verify:${f.file}#${i}`, phase: 'Verify', schema: VERDICT, effort: 'high' })))
      return votes.filter(Boolean).every(v => !v.refuted) ? { ...f, dimension: d } : null
    }))
  })

const confirmed = perDim.flat().filter(Boolean)
log(`${confirmed.length} bulgu doğrulandı`)
return confirmed
```

Çalıştır:

```bash
node bin/maestro run review.js --args '{"diffRef":"main...HEAD"}' --budget 300k
```

Ağa çıkmadan akışı görmek için `--dry-run` ekle; her ajan şemadan üretilmiş sahte bir cevap döner. Script'i düzenleyip ucuza tekrar koşmak için:

```bash
node bin/maestro run review.js --resume <runId>
```

Değişmeyen her `agent()` çağrısı journal'dan gelir; yalnızca değişen çağrı ve onun sonucundan türeyenler canlı koşar.

Kütüphane olarak:

```ts
import { run, AnthropicRunner, attachTerminalProgress } from 'maestro-orchestrator';

const handle = run({ scriptPath: 'review.js', args: { diffRef: 'main...HEAD' }, budget: 300_000 });
const detach = attachTerminalProgress(handle);       // stderr'e ilerleme ağacı
const result = await handle.promise;                 // script'in dönüş değeri
detach();
```

`run()` hemen `{ runId, runDir, promise, events, stop, skip }` döner. `events` üzerinden `agent_start`, `agent_end`, `phase`, `log` ve `budget_tick` olayları akar.

## Codex ile ajan çalıştırma

Codex CLI kurulu ve ChatGPT hesabıyla giriş yapılmışsa ajanlar Codex planından çalışabilir; `ANTHROPIC_API_KEY` gerekmez. Her ajan için ayrı bir `codex exec` süreci açılır:

```bash
node bin/maestro run review.js --runner codex --args '{"diffRef":"main...HEAD"}' --concurrency 4
node bin/maestro mcp --runner codex --concurrency 4
```

Kütüphane olarak:

```ts
import { CodexRunner, run } from 'maestro-orchestrator';

const result = await run({ scriptPath: 'review.js', runner: new CodexRunner() }).promise;
```

`--runner` varsayılanı `anthropic`'tir; `--dry-run` seçilen runner'ın önüne geçer. Model önceliği `new CodexRunner({ model })`, sonra workflow'un `model` seçeneği (`--model` dahil), sonra Codex config varsayılanıdır. Workflow modeli `claude-` ile başlıyorsa Codex'e gönderilmez; böylece Maestro'nun varsayılan Claude modeli Codex modelini değiştirmez. `effort: 'low' | 'medium' | 'high' | 'xhigh'` aynen, `'max'` ise `'xhigh'` olarak gider; verilmezse Codex varsayılanı kullanılır.

Codex kendi shell araçlarını kullanır; Maestro'nun özel `ToolDef` araçları Codex'e aktarılmaz ve istenen özel araçlar bir log satırında adlandırılır. İzolasyonsuz ajan `read-only`, worktree içindeki ajan `workspace-write` sandbox'ıyla koşar. Writer, Codex içinde commit atmaz; değişikliklerini working tree'de bırakır. 2026-11-07 tarihli gerçek çalıştırmada Codex sandbox'ının `.git` metadata'sını salt okunur tuttuğu, ortak Git dizinini `--add-dir` ile vermenin bunu değiştirmediği görüldü. Başarılı ve iptal edilmemiş izole çalıştırmadan sonra runner değişiklik varsa kullanıcının Git kimliğiyle commit atar; mesaj `maestro(codex): ` ile başlar ve görev prompt'unun ilk satırından toplam 72 karaktere kısaltılır. Başarısız çalıştırmalar commit edilmez; kirli worktree inceleme için kalır. Runner'ın commit'i başarısız olursa sonuç da hata bilgisiyle `null` olur.

Kullanıcı Codex config'i varsayılan olarak okunur; API'de `ignoreUserConfig: true` ile kapatılabilir. Her eşzamanlı ajan ayrı bir süreç olduğu için yüksek `--concurrency` değerlerinde bellek kullanımını gözetin. Prompt stdin üzerinden gönderilir ve stdin hemen kapatılır; büyük prompt'lar komut satırı argüman sınırına takılmaz.

Usage her `turn.completed` olayında bütçeye bildirilir. CLI'ın bu olayı kendi içindeki bütün model çağrılarını tek turda toplayabilir; Anthropic runner'ın model çağrısı başına tur ve token sınırları Codex runner'da uygulanmaz.

Sonuç ancak `turn.completed` görülmüşse, ardından başarısızlık gelmemişse, hiçbir `error` olayı kaydedilmemişse ve süreç 0 ile çıkmışsa kullanılabilir. İlerleme mesajı bu koşullar olmadan başarılı sonuç sayılmaz. İptal, Codex'in açtığı alt süreçleri de kapsayan süreç grubunu durdurur.

## Host API

Script'in gördüğü yüzey (spec Seviye 1). Bunların dışında yalnızca JS builtin'leri vardır; `process`, `require`, `fetch`, `console`, `setTimeout` tanımlı değildir.

| API | Döner | Null ve throw |
|---|---|---|
| `agent(prompt, opts?)` | `schema` varsa doğrulanmış obje, yoksa final metin | Terminal API hatası, ajanın atlanması (`handle.skip(id)`) ve koşarken bütçe aşımı **null** döner. Geçersiz schema, girişte bütçe rezervasyonunun yetmemesi, `meta.maxAgents` tavanı ve izolasyonsuz yazma aracı **throw** eder. |
| `parallel(thunks)` | Sonuç dizisi (bariyer) | Asla reject etmez. Throw eden thunk'ın slotu null olur ve log'a yazılır. 4096 öğe üstü throw eder. |
| `pipeline(items, ...stages)` | Öğe başına son aşamanın sonucu | Aşamalar arasında bariyer yoktur. Aşama `(prev, item, index)` alır, ilk aşamada `prev === item`. Throw eden aşama öğeyi null yapar ve kalan aşamaları atlar. Null **dönen** aşama normal değerdir. |
| `phase(title)` | | `meta.phases` tanımlıysa başka başlık throw eder. |
| `log(message)` | | |
| `args` | Tool çağrısının `args` değeri, aynen | |
| `budget` | `{ total, spent(), remaining() }` | `total` yoksa null ve `remaining()` Infinity. |
| `workflow(nameOrRef, args?)` | Alt workflow'un dönüş değeri | Yalnızca bir seviye iç içe; çocuğun içinde throw eder. Aynı semafor, sayaç ve bütçe paylaşılır. |

`agent` opts: `label`, `phase`, `schema`, `model`, `effort` (`low` … `max`), `isolation: 'worktree'`, `tools`. Varsayılan araçlar salt-okurdur: `read_file`, `grep`, `glob` ve izin listeli `bash` (ls, cat, git log/diff/status/show, rg, find). `bash` komutlarının yol argümanları, `read_file` gibi, çalışma dizininin dışına çıkamaz. `bash` ve `shell` ile koşan komutlar `ANTHROPIC_API_KEY` ve `ANTHROPIC_AUTH_TOKEN` değişkenlerini görmez. `write_file`, `edit_file`, `shell` ve `git_commit` yalnızca `isolation: 'worktree'` ile verilir. Yazan ajan, runtime'ın açtığı `wf/<runId>/<label>` branch'ine commit eder; çıkışta branch, temiz status ve en az bir commit Git'ten doğrulanır ve sonuca `branchName` eklenir.

### Özel araçlar

Ajanlara yerleşik olmayan bir yetenek (makale ya da web araması, bir veritabanı, şirket içi bir API) vermek için araç script'in dışında tanımlanır; script yalnızca adını seçer:

```js
// .maestro/tools/arxiv_search.js
export default {
  name: 'arxiv_search',
  description: 'Search arXiv papers. ...',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  write: false,
  async run(input, ctx) { /* ctx.cwd, ctx.signal */ return '...'; },
};
```

```js
// script
const papers = await agent('DML üzerine makaleleri bul', { tools: ['read_file', 'arxiv_search'] })
```

- Dizin varsayılan olarak `.maestro/tools/`'tur, `--tools-dir` ile değişir. Her `*.js`/`*.mjs` dosyası bir aracı ya da bir araç dizisini `export default` eder; `_` ya da `.` ile başlayan dosyalar yardımcıdır ve araç olarak yüklenmez. Kütüphane olarak `run({ tools: [...] })` de olur.
- Denetimler run başlamadan yapılır ve bozuk bir tanım run'ı `tool_invalid` ile başlatmaz: ad yerleşik bir araçla ya da başka bir tanımla çakışmaz, `write` açıkça yazılır ve girdi şeması strict'tir (her objede `additionalProperties: false`, her özellik `required` içinde; opsiyonel alan nullable yapılır).
- `write: true` olan araç yazma aracıdır ve yalnızca `isolation: 'worktree'` ile verilir.
- Araç kodu Maestro'nun kendi sürecinde koşar, script'in sandbox'ında değil; ağa çıkabilir. Okuyan bir ajana ağa çıkan bir araç vermek, okuduğunu dışarı gönderebilmesi demektir.
- `.maestro/tools/` altındaki dosyalar `package.json` script'leri gibi çalıştırılabilir koddur: Maestro onları bir run başlarken, `maestro mcp` ise araç listesini her verişinde yükler. Maestro'yu yalnızca güvendiğin repolarda çalıştır.
- Workflow aracının açıklaması mevcut özel araçları listeler (`maestro mcp` her `tools/list`'te diskten yeniden okur), böylece script'i yazan model adlarını bilir.
- Journal anahtarında yalnızca aracın adı vardır: aracın kodunu değiştirmek eski sonuçları geçersiz kılmaz. Bir run'ın kullandığı aracı silmek ise o run'ın resume'unu bozar, cache'teki ajanlar dahil.

Hazır örnek `examples/tools/arxiv_search.js` arXiv'de makale arar ve API anahtarı istemez; kullanmak için dosyayı `.maestro/tools/` altına kopyala.

Determinizm: script içinde `Date.now()`, `Math.random()` ve argümansız `new Date()` throw eder, çünkü resume cache anahtarı `sha256(prompt + opts)` ve aynı içeriğin kaçıncı çağrısı olduğundan türer. Zaman damgası `args` ile verilir (`new Date(args.ts)` çalışır).

## Kendi harness'ine bağlama

`maestroToolDefinition()` ana ajana verilecek Anthropic tool tanımını üretir (`name: "Workflow"`, `strict: true`). Açıklama metni opt-in politikasını taşır: ne zaman kullanılır, ne zaman kullanılmaz. `handleWorkflowToolCall()` çağrıyı doğrular, run'ı arka planda başlatır ve hemen döner. Sonuç `onComplete` ile gelir.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { handleWorkflowToolCall, maestroToolDefinition, toToolResultBlock } from 'maestro-orchestrator';

const client = new Anthropic();
const tools = [maestroToolDefinition(), /* kendi araçların */];

// Model Workflow aracını çağırdığında:
const res = await handleWorkflowToolCall(toolUse.input, {
  cwd: repoDir,
  budget: 500_000,
  onComplete: (runId, outcome) => queueForModel(runId, outcome),   // sonucu sonraki turda modele ver
});
messages.push({ role: 'user', content: [toToolResultBlock(toolUse.id, res)] });
```

Girdide `script`, `scriptPath` veya `name` alanlarından tam biri verilir. `name`, `.maestro/workflows/<name>.js` dosyasına çözülür. `resumeFromRunId` ile düzenlenmiş script cache'ten devam eder; script verilmezse run dizinindeki `script.js` ve `args.json` yeniden kullanılır. Strict şema keyfi JSON değeri ifade edemediği için `args` JSON-string olarak gönderilir. Geçersiz girdi, eksik veya saf olmayan `meta`, syntax hatası ve var olmayan (ya da `script.js`'i olmayan) bir run'ı resume etme throw etmez; hemen `{ is_error: true, content }` döner.

İsteğe bağlı `cwd` alanı run'ı başka bir dizine taşır. Mutlak yol ya da sunucunun dizinine göre göreli yol olabilir. Ajanlar o dizinde çalışır, yazan ajanlar o dizinin git reposundan branch açar ve run `<cwd>/.maestro` altına yazılır. `scriptPath` da bu dizine göre çözülür. Böylece tek bir sunucu (örneğin `scratchpad`'de açılmış bir Claude Code oturumu) başka bir repo üzerinde çalışabilir. Başkasının kullandığı ana checkout yerine o reponun bir worktree'sini vermek daha güvenlidir. Resume ederken aynı `cwd` verilir, yoksa run bulunamaz. `null` ya da boş string sunucunun dizini demektir. Var olmayan ya da dizin olmayan bir `cwd` hemen `is_error` döner.

Tool ile başlatılan run'lar runId ile kontrol edilir (spec Seviye 1, null/throw tablosundaki kullanıcı satırları):

```ts
import { liveWorkflowAgents, skipWorkflowAgent, stopWorkflowRun } from 'maestro-orchestrator';

liveWorkflowAgents(runId);       // [{ id, label, phase, group }]: canlı ajanlar; run bittiyse null
skipWorkflowAgent(runId, id);    // agent() null döner, journal satırı 'skipped', run devam eder
stopWorkflowRun(runId, 'yeter'); // canlı ajanlar 'skipped' yazılır, onComplete ok:false (run_stopped)
```

Üçü de bilinmeyen ya da bitmiş run için `false`/`null` döner. Ana döngüyle tüm workflow'ların aynı bütçe havuzunu paylaşması için (spec 3.5) `budget` olarak sayı yerine tek bir `new Budget({ total })` örneği verilir ve her çağrıda aynısı geçirilir.

## Claude Code'a bağlama

Aynı Workflow aracı stdio üzerinden bir MCP sunucusu olarak açılır ve `tools/list` dört araç döner:

- `Workflow`: run'ı başlatır, hemen `{ runId, scriptPath, status: 'started' }` döner. `cwd` verilirse run oturumun dizini yerine o repoda çalışır (yukarıdaki `cwd` paragrafı).
- `WorkflowResult({ runId, wait? })`: Run sürerken `{ status: 'running', liveAgents }`, sonra `done` ya da `failed` döner. `wait: true` ile çağrı run bitene kadar açık kalır ve yoklamaya gerek kalmaz: Claude Code 2 dakikadan uzun süren bir MCP çağrısını arka plana alır, sonucu modele bildirim olarak verir. Bekleyen çağrı, istemci `progressToken` gönderdiyse 30 saniyede bir canlı ajanların adlarıyla `notifications/progress` yollar; böylece boşta kalan çağrı zaman aşımı çağrıyı kesmez. Tek seferlik `claude -p` oturumu tur bitince kapandığı için arka plandaki sonucu beklemez; sonucu almak için etkileşimli bir oturum kullanın.
- `WorkflowStop({ runId })`: run'ı durdurur. Script `run_stopped` ile reddeder, journal kalır ve run sonradan `resumeFromRunId` ile sürdürülebilir.
- `WorkflowSkip({ runId, agentId })`: `liveAgents` içindeki bir ajanı atlar; o `agent()` çağrısı `null` döner.

Kendi projende kullanmak için sunucuyu Claude Code'a ekle. Komutu bu reponun kökünde, `npm run build`'den sonra çalıştır. Paket npm'de yayınlı değil; `npx maestro` npm'deki ilgisiz `maestro` paketini indirir, kullanma.

```bash
claude mcp add --scope user maestro -- node "$PWD/bin/maestro" mcp
```

Script yazma rehberini bütün projelerde görünen bir skill olarak ekle:

```bash
mkdir -p ~/.claude/skills/maestro-workflow-authoring && cp skill/SKILL.md ~/.claude/skills/maestro-workflow-authoring/SKILL.md
```

Varsayılan runner ile sunucu Claude Code'un ortamındaki `ANTHROPIC_API_KEY`'i kullanır. Ajanların maliyeti bu anahtarın hesabına yazılır. `mcp --runner codex` ise Codex CLI oturumunu kullanır.

`maestro mcp` sunucusu `--cwd`, `--state-dir`, `--tools-dir`, `--budget`, `--concurrency`, `--model`, `--runner` ve `--dry-run` seçeneklerini alır. `--budget` oturumun tamamı için tek havuzdur: sunucunun başlattığı bütün run'lar aynı `Budget` örneğinden harcar. stdout MCP kanalıdır, tanılar stderr'e gider. İstemci bağlantıyı kapatınca (stdin biter) sunucu kapanır, süren run'lar durdurulur (journal'ları resume için kalır) ve komut 0 ile çıkar.

## CLI

```text
maestro run <script.js> [--args <json>] [--args-file f] [--resume <runId>] [--budget 500k]
                        [--dry-run] [--cwd d] [--state-dir d] [--tools-dir d] [--concurrency n] [--model m]
                        [--runner <anthropic|codex>]
maestro gc [--delete] [--force] [--cwd d]
maestro show <runId> [label] [--cwd d] [--state-dir d]
maestro viz <runId> [--cwd d] [--state-dir d] [--port n] [--no-open] [--out f.html] [--widget]
maestro mcp [--cwd d] [--state-dir d] [--tools-dir d] [--budget 500k] [--concurrency n] [--model m]
            [--runner <anthropic|codex>] [--dry-run]
```

`maestro run` sonucu stdout'a JSON olarak yazar, ilerleme stderr'e gider; Ctrl-C run'ı durdurur ve resume komutunu gösterir. `maestro mcp`, stdin bitince 0 ile çıkar; `--budget` orada her run için değil, oturum boyunca paylaşılan tek havuz içindir.

`maestro gc` kirli worktree'leri ve `wf/*` branch'lerini listeler; birleşmiş sayılan branch'ler, HEAD'in atası olanlar ya da tüm commit'leri cherry-pick ile alınmış olanlardır. `--delete` temiz kalmış worktree'leri ve birleşmiş branch'leri siler. Kirli worktree'ler (commit edilmemiş iş) ve birleşmemiş branch'ler yalnızca `--delete --force` ile silinir.

## Run dizini ve resume

`.maestro/runs/<runId>/` dizininde `script.js`, `args.json`, `run.json`, `journal.jsonl` ve `blobs/` bulunur. `run.json` run'ın modelini ve runner'ını tutar: cache anahtarı bunları içermediği için, resume ederken biri değişirse log'a "journal'daki sonuçlar eski modelden" uyarısı düşer. Journal satır başına bir `agent()` çağrısı tutar (`key = sha256(prompt + "\n" + canonicalJSON(opts \ {label, phase})) + ":" + n`). Yalnızca `status: 'ok'` satırlar cache isabetidir. `null` (API hatası) ve `skipped` (bütçe, atlama, durdurma) satırları resume'da tekrar koşar. Böylece bütçeyi artırıp resume etmek yarım kalan ajanları canlandırır. 64 KB üstü sonuçlar `blobs/<key>.json` dosyasına yazılır. Her canlı satır ayrıca `trace` taşır: ajanın araç çağrıları ve final metninin ilk 2.000 karakteri; `maestro show <runId>` ajanları listeler, `maestro show <runId> <label>` birinin trace'ini okunur basar.

Run dizininde bir de `events.jsonl` vardır: her olay (ajan başladı, slot aldı, bitti, faz, log, bütçe) duvar saati zamanıyla bir satırdır. Ajanın prompt'u (ilk 4.000 karakter), modeli, effort'u ve araçları da buraya yazılır. Dosya yalnızca görüntüleme içindir. Resume ve cache journal'dan çalışır, bu dosyaya bakmaz. Yazılamazsa run durmaz, log'a bir satır düşer. Her başlatma ve resume dosyaya kendi `run_start` satırıyla eklenir.

## Run'ı izlemek: `maestro viz`

```bash
node ~/maestro/bin/maestro viz <runId> --cwd <repo>
```

Komut tarayıcıda run'ın zaman çizelgesini açar:
- **Şeritler:** her faz bir şerittir.
- **Çubuklar:** her ajan bir çubuktur. Önce gelen ince çizgi, ajanın eşzamanlılık slotu beklediği süredir.
- **Renkler:** çalışıyor, tamam, null, atlandı ve önbellekten.
- **Ayrıntı:** bir çubuğa tıklayınca prompt, sonuç, hata, araç çağrıları ve token'lar açılır.

Üstte ajan sayıları, süre, token, önbellek oranı ve bütçe durur. Resume edilmiş bir run'da denemeler arasında geçiş yapılır.

Sayfa dosyaları saniyede bir okur. Bu yüzden başka bir süreçte koşan bir run'ı da canlı izler: bir Claude Code oturumunun MCP sunucusu ya da başka bir terminaldeki `maestro run` olabilir. Sunucu yalnızca `127.0.0.1`'e bağlanır; Ctrl-C ile kapanır.

- `--out rapor.html` sunucu açmadan tek bir HTML dosyası yazar: bütün olaylar ve ajan ayrıntıları gömülüdür, internetsiz açılır, paylaşılabilir.
- `--port` sabit bir port seçer, `--no-open` tarayıcıyı açmaz.
- `events.jsonl`'i olmayan eski run'larda yalnızca journal satırları listelenir.
- `--widget`, son denemenin anlık görüntüsünü bir sohbet arayüzünün satır içi widget aracı için HTML parçası olarak stdout'a basar (Claude masaüstü uygulamasında `show_widget`). Parça şunlara uyar: doctype, `html` ve `body` yok; arka plan saydam; host'un `--text-*`, `--surface-*` ve `--border*` değişkenleri; 400/500 ağırlık; 11px altı yazı yok; sabit konum ve iç kaydırma yok. Çubuğa tıklayınca bekleme ve çalışma süresi, token'lar, hata ve sonucun ilk 280 karakteri görünür. Canlı değildir, veri gömülüdür. En çok 400 ajan çizilir; fazlası yazıyla belirtilir. Claude Code'da skill, run bitince bu parçayı sohbette göstermeyi söyler.

## Örnekler

```bash
npm run build
```

```bash
node examples/review-changes.js --dry-run
```

```bash
node examples/find-edge-cases.js --dry-run
```

```bash
node examples/fanout-writers.js --dry-run
```

- `review-changes`: spec Seviye 4 Örnek 1, bul → üç skeptikle oyla → sentezle.
- `find-edge-cases`: spec Seviye 4 Örnek 2, loop-until-dry.
- `fanout-writers`: izole yazan ajanlar paralel commit eder, tek bir koordinatör branch'leri cherry-pick eder. Dry run geçici bir git reposu kurar; worktree, commit ve çıkış doğrulaması gerçekten çalışır.

Workflow script'leri `examples/workflows/` altındadır. `examples/<ad>.js` dosyaları onları `run()` ile koşturan ince çalıştırıcılardır. `--dry-run` olmadan gerçek API kullanılır, `ANTHROPIC_API_KEY` yoksa açıklayıp çıkar.

Gerçek API ile kısa bir duman testi, varsayılan test koşusunun dışında:

```bash
npm run smoke
```

## Maliyet ve effort

`review-changes` gerçek API ile, `MAESTRO_MODEL=claude-sonnet-5-5`, `MAESTRO_BUDGET=250000`. "Bug'lı kurulum": lula reposunda `2a877f1a^1` için açılmış geçici bir worktree, `diffRef: "2a877f1a 2a877f1a^1"`; bu diff `lib/moderation/image-moderation-queue.ts` içinde bilinen bir sayım-upsert yarışı ve `claim_image_moderation` içinde eksik bir `next_attempt_at <= now()` kontrolü içerir. Toplam girdi = cache'siz girdi + cache yazımı + cache okuması. Dolar, Sonnet 5.5 fiyatıyla hesaplanır: girdi $2/M, cache yazımı $2,50/M (5 dakika), cache okuması $0,10/M, çıktı $10/M.

| Koşu | Skeptik effort | Toplam girdi | Cache'ten okunan | Çıktı | Dolar | Bulgu → skeptik → geçen → sentez |
|---|---|---:|---:|---:|---:|---|
| v1, temiz PR diff'i, cache yok | high | ölçülmedi | yok | ölçülmedi | $0,77 | 0 bulgu |
| v1, bug'lı kurulum, cache yok | high | 3,36M | yok | 135k | $8,08 | 13 → 39 → 11 → 6, iki bug da bulundu |
| v1.1, bug'lı kurulum, cache | high | 2,97M | 2,02M (%68) | 102k | $3,36 | 10 → 30 → 9 → 6, iki bug da (2. ve 3. sıra) |
| v1.1, bug'lı kurulum, cache | medium | 2,28M | 1,64M (%72) | 79k | $2,39 | 11 → 33 → 10 → 5, iki bug da (1. ve 2. sıra) |

v1.1 koşuları 2026-10-25'te yapıldı (run `20261025-212908-d1a8b7` ve `20261025-213146-43651c`). Okuma notları:

- **Cache.** Girdi maliyeti v1'de $6,72 (3,36M × $2), v1.1 high koşusunda $2,34: %65 düşüş. Bulucular her koşuda farklı sayıda bulgu üretir (13 yerine 10), bu yüzden ajan başına bakmak daha adil: girdi maliyeti ajan başına $0,156'dan $0,069'a iner (%56). Tek turlu sentez ajanı cache'ten yalnızca araçlar + sistem prefix'ini okur (%16); çok turlu skeptikler %70 civarı okur.
- **Effort.** Skeptik başına maliyet high'da $0,103, medium'da $0,064 (%38 düşüş; bu iki rakam cache okuması $0,20/M sayılarak hesaplandı, doğru fiyat $0,10/M olduğu için ikisi de birkaç sent yüksektir); skeptik başına çıktı 2,9k'dan 2,0k tokene iner. İki koşuda da tam olarak bir bulgu çürütüldü ve iki bilinen bug geçti. Medium'da oylar daha sık bölündü (11 bulgudan 3'ünde 2-1, high'da 10'dan 1'inde), yani medium skeptikler daha az otomatik onay verdi; bu tek bir koşu, istatistik değil.
- Sonuç: cache her koşuda açık. Bu ölçümde `medium` skeptikler bulgu kalitesini kaybetmeden daha ucuz; tek koşuya dayanarak varsayılan `high` bırakıldı.

Skeptik effort'u `args.skepticEffort` ile değişir, varsayılan `high`:

```bash
node examples/review-changes.js --args '{"diffRef":"main...HEAD","skepticEffort":"medium"}'
```

## Geliştirme

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run build
```

Testler Vitest'tir ve ağa çıkmaz. Anthropic runner testleri gerçek SDK `toolRunner` ve `parse` kodunu sahte bir `fetch` üstünde koşturur; Codex runner testleri JSONL üreten sahte bir executable kullanır, gerçek Codex çağrılmaz. İzolasyon testleri geçici git repolarında gerçek worktree açar. Diğer her şey `FakeRunner` (`src/testing/fake-runner.ts`) ile koşar.

| Bileşen | Kaynak | Spec |
|---|---|---|
| Journal | `src/journal.ts` | 3.1 |
| Agent runner, araçlar | `src/runner.ts`, `src/codex-runner.ts`, `src/tools.ts`, `src/custom-tools.ts` | 3.2 |
| Script runtime, schema | `src/runtime.ts`, `src/schema.ts` | 3.3 |
| Scheduler | `src/scheduler.ts` | 3.4 |
| Budget | `src/budget.ts` | 3.5 |
| Isolation | `src/isolation.ts` | 3.6 |
| Observability | `src/progress.ts`, `src/event-log.ts`, `src/viz.ts`, `src/viz-page.ts`, `src/viz-widget.ts` | 3.7 |
| Tool yüzeyi | `src/workflow.ts`, `src/tool.ts`, `src/mcp.ts`, `src/cli.ts` | Seviye 2 |

## Spec'ten sapmalar

Spec'ten koda birebir geçmeyen maddeler ve gerekçeleri aşağıdadır. Spec'in açık bıraktığı ve sapma sayılmayan seçimler [docs/decisions.md](docs/decisions.md) içindedir.

- **`betaZodTool` ve `zodOutputFormat` yerine JSON Schema yardımcıları (3.2).** Script'ler şemayı JSON Schema olarak verir, araçlar da JSON Schema ile tanımlıdır. Runner araçları `strict: true` olan `BetaRunnableTool` nesneleri olarak `toolRunner`'a verir. Final aşamasında `betaJSONSchemaOutputFormat` ve yerel bir strict dönüşümü kullanır. JSON Schema'yı zod'a çevirip geri JSON Schema'ya çevirmek bilgi kaybettirirdi. SDK'nın kendi dönüşümü, `type: ['object','null']` düğümlerinin `properties`'ini düşürüyor. Sonuç ayrıca script'in özgün şemasına karşı doğrulanır.
- **`toolRunner` `thread: false` ile koşar (3.2).** SDK (1.3.0'dan beri) varsayılan olarak sunucu tarafı thread kullanır. Runner-seviyesi retry, tek `max_tokens` devamı ve "aynı transcript üstünde" parse için transcript yerelde tutulur.
- **Strict tool şemasında `args` bir JSON-string'dir (kapsam eki, `src/tool.ts`).** Strict mod her objede `additionalProperties: false` ister ve tipsiz şemayı desteklemez. Bu yüzden `args?: any` olarak ifade edilemez. Handler string'i parse eder, gerçek bir değeri de kabul eder. Tüm alanlar `required` listesinde, `string | null` tipindedir.
- **Kirli yazan ajanın yolu dönüş değerine yazılmaz (3.6).** Spec bir yerde yolun ve `git diff --stat` özetinin "dönüş değerine ve log'a" yazılacağını söyler. Başka bir yerde ise commit etmeyen ajanın gc lane'ine düştüğünü ve koordinatöre girmediğini söyler. Kirli ajan null döner; yol ve diff özeti journal satırının `worktree` alanına ve log'a yazılır.
- **Semafor slotu ajanın tüm canlı koşusu boyunca tutulur (3.4).** Slot yalnızca HTTP isteği sırasında değil, araç yürütmeleri dahil `runner.run` boyunca tutulur. Worktree kurulumu, journal yazımı, script kodu, `parallel`/`pipeline` beklemeleri ve `workflow()` slot tutmaz. Bu, "aynı anda en fazla N canlı ajan" anlamını korur.
- **Örnek script'ler çalıştırıcı + script olarak ikiye ayrıldı (Seviye 4).** Spec script'i (`export const meta` + en üstte `return`) ne geçerli bir ES modülüdür ne de CommonJS script'i. Bu yüzden `node examples/<ad>.js` dosyası, `examples/workflows/<ad>.js` script'ini `run()` ile koşturan bir çalıştırıcıdır.
- **`fanout-writers` örneği hiç branch gelmezse koordinatörü çağırmaz (Seviye 4).** Spec parçacığı koordinatörü boş listeyle çağırırdı. O çağrı commit edecek bir şey bulamaz ve "no handoff" ile null döner.
- **`workflow gc` komutu `maestro gc` adını taşır (3.6).** Ayrıca "birleşmiş" tespiti ata ilişkisinin yanında `git cherry` ile patch-eşdeğerliğine de bakar, çünkü koordinatör kalıbı cherry-pick kullanır ve `git branch --merged` cherry-pick'lenmiş branch'leri birleşmemiş gösterir.
- **`/workflows` paneli yok (3.7).** Terminal ilerleme ağacı (`src/progress.ts`) ve olay akışı (`handle.events`) vardır. Panel host'un arayüzüdür. Buna karşılık tarayıcıda bir run görünümü var (`maestro viz`), çünkü kullanıcı istedi. Non-goals "ajan başına UI yok" der. Görünüm salt-okurdur ve run'ı yönetmez.
- **Policy bileşeni ayrı bir modül değil (Seviye 2).** Opt-in kuralı metin olarak Workflow tool açıklamasında (`WORKFLOW_TOOL_DESCRIPTION`) ve skill'de yaşar. Sayısal sınırlar koddadır (`meta.maxAgents`, global tavan, bütçe).
- **İç içe workflow'da çocuğun `meta.maxAgents` değeri uygulanmaz (3.4).** Sayaç paylaşıldığı için üst run'ın tavanı geçerlidir; çocuğun değeri log'a yazılır.
- **Determinizm ezmesi saldırgana dayanıklı değildir (3.3).** `Object.getPrototypeOf(Date)` hâlâ özgün `Date`'e ulaşır. Spec'in de söylediği gibi `vm` bir güvenlik sınırı değildir. Buna karşılık saati okuyan argümansız `Intl.DateTimeFormat#format` da ezilmiştir.
- **MCP sunucusu iki değil dört araç listeler (kapsam eki).** `Workflow` ve `WorkflowResult`'ın yanında `WorkflowStop` ve `WorkflowSkip` vardır. Null/throw tablosunun "kullanıcı run'ı durdurur" ve "kullanıcı ajanı canlı atlar" satırları, tool veya MCP ile başlatılan run'larda başka türlü üretilemiyordu.
- **Kök `{ type: 'object' }` şeması `properties` olmadan kabul edilir (Seviye 1).** Tablo yalnızca kökün object olmamasını ve `required ⊄ properties` durumunu throw sayar; boş obje bu şemayı sağlar.
- **Stage 2'de `max_tokens` "devam et" ile değil, daha büyük `max_tokens` ile tekrar denenir (3.2).** Bir devam turu, kesilmiş JSON belgesinin kalanını değil yeni bir belge üretirdi. Araç döngüsünde kural birebir uygulanır.
- **Codex runner'da yazan ajan commit atmaz (3.6).** Codex sandbox'ı `.git`'i salt-okur tutar; başarılı bir izole koşudan sonra commit'i runner atar ve ajana tek bir talimat gider ("commit atma"). Şema cevabı da tek denemedir, ikinci parse denemesi yoktur.
- **Spec'te olmayan ekler (kapsam eki).** Workflow aracının `cwd` girdisi, `WorkflowResult`'ın `wait` modu, script dışında tanımlanan özel araçlar (`.maestro/tools`, `--tools-dir`), run dizinindeki `events.jsonl` ve `run.json`, `maestro show` ve `maestro viz`.
- **Agent SDK binding'i ve tek aşamalı runner yok (Açık soru 1 ve 2).** Spec bunları v2'ye ve sonraki bir optimizasyona bırakır.
