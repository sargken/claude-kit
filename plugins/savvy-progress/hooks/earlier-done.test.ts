import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const PROGRESS = 'mcp__savvy-progress__progress'

const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

// After a restart the orchestrator re-posts the plan: task 1 was accepted in an earlier session.
const replan = (done: unknown) =>
  ({
    tool: PROGRESS,
    title: 'Ship the thing',
    phase: 'delegate',
    total: 2,
    done: 1,
    tasks: [
      { title: 'Write the parser', tier: 'careful', done },
      { title: 'Wire the CLI', tier: 'light', after: [1] },
    ],
  }) as never

// The engine beneath the plugin, for a worker run: set up before the test's first call on $.
const worker = (on: On) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }) as never)
}

// A finished run in this session whose description is `description`.
const finishedRun = async ($: Engine, description: string) => {
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description, subagentType: 'savvy-careful', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'ok' })
}

// What the pane draws, as one string per row: Text on the terminal, the Svg alt text on the desktop.
const rows = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'savvy-agents', props: pane })
  const alts = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
  const toggle = (await ui.find({ key: 'done' }))?.props.label as string | undefined
  // How many rows name `title`: Text rows on the terminal, Svg rows on the desktop.
  const count = async (title: RegExp) =>
    surface === 'desktop' ? alts.filter(a => title.test(a)).length : (await ui.findAll({ type: 'Text', text: title })).length
  return { ui, alts, toggle, count }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a task done in an earlier session shows under Finished, not Planned`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    expect(await $.tool.call(replan(true))).toMatchObject({ result: 'ok: Tasks 1/2' })

    const { ui, alts, toggle, count } = await rows($, surface)
    expect(toggle).toBe('▾ Finished · 1')
    expect(await ui.find({ text: /Planned · 1/ })).toBeDefined()
    expect(await count(/Write the parser/)).toBe(1)
    expect(await count(/Wire the CLI/)).toBe(1)
    if (surface === 'desktop') {
      expect(alts).toContain('1. Write the parser: finished')
      expect(alts).toContain('2. Wire the CLI: planned')
      // The done check, not the planned clock, and no "after" text.
      const row = String((await ui.findAll({ type: 'Svg' })).find(el => el.props.alt === '1. Write the parser: finished')?.props.source)
      expect(row).toContain('stroke="#3B9C5F"')
      expect(row).not.toContain('after')
    }
    await ui.unmount()

    // The crew button still counts every task.
    const bar = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await bar.find({ key: 'savvy-agents' }))?.props.label).toBe('×2')
  })

  test(`${surface}: a done task that matches a run in this session is drawn once`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    worker(on)
    await $.tool.call(replan(true))
    await finishedRun($, 'Write the parser')

    const { ui, alts, toggle, count } = await rows($, surface)
    expect(toggle).toBe('▾ Finished · 1')
    expect(await count(/Write the parser/)).toBe(1)
    // The one row is the run's, not the task's.
    if (surface === 'desktop') expect(alts).toContain('Write the parser: Opus 5.5, finished')
    else expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    await ui.unmount()

    const bar = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await bar.find({ key: 'savvy-agents' }))?.props.label).toBe('×2')
  })

  for (const odd of ['true', 1] as const) {
    test(`${surface}: done given as ${typeof odd} ${JSON.stringify(odd)} counts as not done`, async ($, on) => {
      on('ui.open', () => ({ value: { isPlaced: true } }))
      await $.tool.call(replan(odd))

      const { ui, toggle } = await rows($, surface)
      expect(toggle).toBeUndefined()
      expect(await ui.find({ text: /Planned · 2/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test(`${surface}: collapsing Finished hides the earlier-finished row`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call(replan(true))

    const before = await rows($, surface)
    expect(await before.count(/Write the parser/)).toBe(1)
    await before.ui.press({ key: 'done' })
    await before.ui.unmount()

    const after = await rows($, surface)
    expect(after.toggle).toBe('▸ Finished · 1')
    expect(await after.count(/Write the parser/)).toBe(0)
    expect(await after.count(/Wire the CLI/)).toBe(1)
  })
}
