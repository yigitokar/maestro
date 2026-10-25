export const meta = {
  name: 'fanout-writers',
  description: 'N izole yazan ajan paralel commit eder, tek koordinatör branch\'leri birleştirir',
  phases: [{ title: 'Write' }, { title: 'Merge' }],
}

// Spec Seviye 4, "Fan-out writers → coordinator merge" kalıbı.
// args: { tasks: Array<{ key: string, brief: string }> }
// Her yazan ajan runtime'ın açtığı wf/<runId>/<key> branch'ine commit eder; branchName'i runtime ekler (3.6).

const WRITE_TOOLS = ['read_file', 'grep', 'glob', 'bash', 'write_file', 'edit_file', 'shell', 'git_commit']
const WRITE_RESULT = { type: 'object', properties: {
  summary: { type: 'string' },
  filesTouched: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'filesTouched'] }

const TASKS = args.tasks

const branches = (await parallel(TASKS.map(t => () =>
  agent(`${t.brief}. Bitince değişikliklerini commit et; tek paragraf özet ve dokunduğun dosyaları döndür.`,
    { label: t.key, phase: 'Write', isolation: 'worktree', tools: WRITE_TOOLS, schema: WRITE_RESULT }))))
  .filter(Boolean)   // null = commit yok veya çıkış doğrulaması geçmedi
log(`${branches.length}/${TASKS.length} branch geldi`)
if (!branches.length) return null

const overlap = branches.flatMap(b => b.filesTouched).filter((f, i, a) => a.indexOf(f) !== i)
if (overlap.length) log(`çakışma adayı dosyalar: ${[...new Set(overlap)].join(', ')}`)

return agent(
  `Şu branch'leri sırayla ana branch'in üstüne cherry-pick et, çatışmaları çöz, testleri koştur, sonuç branch adını döndür. ` +
  `Çakışma adayı dosyalar: ${[...new Set(overlap)].join(', ') || 'yok'}.\n` +
  branches.map(b => `- ${b.branchName}: ${b.summary} (${b.filesTouched.length} dosya)`).join('\n'),
  { label: 'coordinator', phase: 'Merge', isolation: 'worktree', tools: WRITE_TOOLS, schema: WRITE_RESULT, effort: 'high' })
