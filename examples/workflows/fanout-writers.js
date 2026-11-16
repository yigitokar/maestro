export const meta = {
  name: 'fanout-writers',
  description: 'N isolated writer agents commit in parallel, one coordinator merges the branches',
  phases: [{ title: 'Write' }, { title: 'Merge' }],
}

// The "fan-out writers → coordinator merge" pattern.
// args: { tasks: Array<{ key: string, brief: string }> }
// Each writer commits to the branch the runtime opened, wf/<runId>/<key>; the runtime adds branchName.

const WRITE_TOOLS = ['read_file', 'grep', 'glob', 'bash', 'write_file', 'edit_file', 'shell', 'git_commit']
const WRITE_RESULT = { type: 'object', properties: {
  summary: { type: 'string' },
  filesTouched: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'filesTouched'] }

const TASKS = args.tasks

const branches = (await parallel(TASKS.map(t => () =>
  agent(`${t.brief}. When you finish, commit your changes; return a one-paragraph summary and the files you touched.`,
    { label: t.key, phase: 'Write', isolation: 'worktree', tools: WRITE_TOOLS, schema: WRITE_RESULT }))))
  .filter(Boolean)   // null = no commit, or the exit check did not pass
log(`${branches.length}/${TASKS.length} branches arrived`)
if (!branches.length) return null

const overlap = branches.flatMap(b => b.filesTouched).filter((f, i, a) => a.indexOf(f) !== i)
if (overlap.length) log(`files that may conflict: ${[...new Set(overlap)].join(', ')}`)

return agent(
  `Cherry-pick these branches onto the main branch in order, resolve conflicts, run the tests, and return the name of the resulting branch. ` +
  `Files that may conflict: ${[...new Set(overlap)].join(', ') || 'none'}.\n` +
  branches.map(b => `- ${b.branchName}: ${b.summary} (${b.filesTouched.length} files)`).join('\n'),
  { label: 'coordinator', phase: 'Merge', isolation: 'worktree', tools: WRITE_TOOLS, schema: WRITE_RESULT, effort: 'high' })
