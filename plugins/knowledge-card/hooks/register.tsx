import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card } from '../types'

const MODEL = 'claude-sonnet-5-5'
const EFFORT = 'low'
const EVERY_MS = 3_000 // how often to check whether a card is due
const FIRST_AFTER_MS = 10_000 // a turn must run this long before it earns a card
const MIN_GAP_MS = 20_000 // at least this long between two model calls, so a failing call cannot loop
const KEEP = 14 // recent actions handed to the model
const SAID = 3 // recent things the assistant said, handed to the model
const SAID_CHARS = 400
const LEARNED_MAX = 500 // titles remembered across sessions; the oldest drop out
const LEARNED_SENT = 80 // recent titles handed to the model so it avoids them
const STORE_KEY = 'learned'

const card = atom({ plugin: 'knowledge-card', key: 'card' } as const, null)

const SYSTEM = `你是一个“知识卡片”作者。用户在等 AI 干活，你要借这段等待时间，教他一个立刻能看懂的小知识。你会拿到：用户任务、助手最近说的话、最近的操作、用户已经学过的知识点。
请严格输出三行，格式如下：
标题：<这个知识点的名字，不超过 12 个字>
解释：<一句大白话，不超过 50 个字，说清它是什么、有什么用>
例子：<一个贴近当前任务的小例子，不超过 60 个字>
要求：
- 讲什么：优先讲助手“眼前这一步”用到的概念；这一步没有值得讲的，就讲当前任务所在领域的一个通用知识。
- 面向零基础：解释里不能依赖别的术语。必须出现专业词（如 rebase、图层、API）时，保留英文原词（中文词也附上常见英文名），并用大白话顺手解释。
- 例子要具体，用当前任务里的真实对象，不要泛泛而谈。
- 不要重复“已学过”里的任何知识点，也不要换个名字讲同一件事。
- 不要编造没出现过的事实；不要提到密钥、令牌、密码。`

// anything that looks like a credential is masked before it leaves for the model
const redact = (s: string) =>
  s
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[bpas]|AKIA)[-_A-Za-z0-9]{8,}/g, '***')
    .replace(/((?:token|key|secret|passw(?:or)?d|auth\w*)["']?\s*[=:]\s*["']?)\S+/gi, '$1***')
    .replace(/(--(?:\w+-)?(?:token|key|secret|passw(?:or)?d|auth\w*)\s+)\S+/gi, '$1***')

// a short, readable trace of one tool call: what it was and what it touched
const brief = (tool: string, e: Record<string, unknown>) => {
  const pick = [e.description, e.command, e.file_path, e.path, e.pattern, e.url, e.query, e.prompt].find(v => typeof v === 'string') as string | undefined
  return `${tool}${pick ? `: ${redact(pick).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`
}

// titles are compared without spaces or case, so "Git rebase" and "git  Rebase" count as one ("C++" and "C#" stay apart)
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, '')

const parse = (raw: string): Card | null => {
  const text = raw.replace(/[*`]/g, '')
  const field = (name: string) => text.match(new RegExp(`^\\s*${name}[：:]\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["“「]|["”」]$/g, '') ?? ''
  const title = field('标题').slice(0, 24)
  const explain = field('解释').slice(0, 120)
  const example = field('例子').slice(0, 140)
  return title && explain ? { title, explain, example } : null
}

// titles the person has already learned, oldest first
async function learned($: EngineInterface): Promise<string[]> {
  try {
    const v = await $.store.get(STORE_KEY)
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

// Clawd in pixels (a 24 x 13 grid): graduation cap, a black pointer held up at an angle, and a bulb that glows
const PIXELS: [number, number, number, number, string][] = [
  [8, 11, 1, 2, '#D97757'], [10, 11, 1, 2, '#D97757'], [13, 11, 1, 2, '#D97757'], [15, 11, 1, 2, '#D97757'], // feet
  [7, 5, 10, 6, '#D97757'], // body
  [9, 6, 1, 2, '#1F1E1D'], [14, 6, 1, 2, '#1F1E1D'], // eyes
  [6, 8, 1, 2, '#B9573B'], [17, 7, 1, 2, '#B9573B'], [18, 7, 1, 1, '#B9573B'], // arms, the right one raised
  [18, 8, 1, 1, '#1F1E1D'], [19, 7, 1, 1, '#1F1E1D'], [20, 6, 1, 1, '#1F1E1D'], [21, 5, 1, 1, '#1F1E1D'], [22, 4, 1, 1, '#1F1E1D'], [23, 3, 1, 1, '#C9C9CE'], // pointer
  [9, 2, 6, 1, '#3B3B47'], [6, 3, 12, 1, '#2A2A33'], [9, 4, 6, 1, '#2A2A33'], // cap
  [6, 4, 1, 2, '#F2C14E'], [6, 6, 1, 1, '#D9A02A'], // tassel
  [2, 0, 2, 1, '#FFD43B'], [1, 1, 4, 2, '#FFD43B'], [2, 3, 2, 1, '#FFD43B'], [2, 1, 1, 1, '#FFF2A8'], [2, 4, 2, 1, '#8D8D93'], // bulb
  [0, 1, 1, 1, '#FFD43B'], [5, 1, 1, 1, '#FFD43B'] // rays
]
const CLAWD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 13" shape-rendering="crispEdges">' +
  '<circle cx="3" cy="2.2" r="2.8" fill="#FFD43B" opacity="0.3"><animate attributeName="opacity" values="0.12;0.45;0.12" dur="1.8s" repeatCount="indefinite"/></circle>' +
  PIXELS.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('') +
  '</svg>'

export const register: Register = on => {
  let task = ''
  let log: string[] = []
  let said: string[] = []
  let isRunning = false // a main-loop turn is in progress
  let isBusy = false // a model call is in flight
  let startedAt = 0 // when the current turn began
  let lastAt = 0 // when the last model call began
  let hasWarned = false // one notice per task when the model call fails
  let isStopped = false // this task's round made no card (a repeat, a bad reply, a failed call): no more calls until the next task or a click
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    timer?.cancel() // never two timers, however often the session starts
    timer = $.clock.every(EVERY_MS, async () => {
      if (!isRunning || isBusy || isStopped) return
      isBusy = true // before any await, so two ticks cannot both get past the check
      let hasCalled = false
      let isShown = false
      try {
        if (await read($, card)) return // a card is on screen: nothing new until it is dismissed
        const now = await $.clock.now()
        if (now - startedAt < FIRST_AFTER_MS || now - lastAt < MIN_GAP_MS) return
        hasCalled = true

        const seen = await learned($)
        const seenSet = new Set(seen.map(norm))
        const recent = seen.slice(-LEARNED_SENT)
        const base =
          `用户任务：${redact(task).slice(0, 500) || '（未知）'}\n\n` +
          `助手最近说的话（旧到新）：\n${said.slice(-SAID).join('\n') || '（没有）'}\n\n` +
          `最近的操作（旧到新）：\n${log.slice(-KEEP).join('\n') || '（没有）'}\n\n` +
          `已学过的知识点：${recent.join('、') || '无'}`

        let made: Card | null = null
        let tried = ''
        for (let attempt = 0; attempt < 2 && !made; attempt++) {
          const r = await $.model.complete({
            model: MODEL,
            effort: EFFORT,
            maxTokens: 1500, // room for the thinking as well as the three lines
            timeoutMs: 25_000,
            system: SYSTEM,
            prompt: tried ? `${base}\n\n刚才的“${tried}”已经学过了，换一个不同的知识点。` : base
          })
          if (!r.isAnswered) {
            if (!hasWarned) {
              hasWarned = true
              $.ui.toast(`知识卡片：小模型没有回复（${r.reason}）`)
            }
            return
          }
          const c = parse(r.text)
          if (!c) return // unreadable reply: try again after the gap
          if (seenSet.has(norm(c.title))) tried = c.title
          else made = c
        }

        // another card may have appeared while the call was out; never replace what the person is reading
        if (made && !(await read($, card))) {
          await update($, card, () => made)
          isShown = true
        }
      } catch (error) {
        if (!hasWarned) {
          hasWarned = true
          $.ui.toast(`知识卡片：小模型调用失败（${error instanceof Error ? error.message.slice(0, 60) : '未知原因'}）`)
        }
      } finally {
        if (hasCalled && !isShown) isStopped = true // no card came of this round: wait for the next task rather than call again
        try {
          if (hasCalled) lastAt = await $.clock.now()
        } finally {
          isBusy = false
        }
      }
    })

    return result
  })

  // a prompt the user typed (or a scheduled trigger) starts a new task. A background task's notification, a peer's
  // message or a plugin's prompt must not wipe the task context.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    const isNewTask = kind === 'composer' || kind === 'bridge' || kind === 'sdk' || kind === 'scheduled-trigger'
    if (e.text && isNewTask) {
      task = e.text
      log = []
      said = []
      hasWarned = false
      isStopped = false
    }
    return next(e)
  })

  // a main-loop turn begins: the clock for the first card starts here, however the turn was started
  on('turn.start', async ($, e, next) => {
    isRunning = true
    startedAt = await $.clock.now()
    return next(e)
  })

  // note what the main assistant says as each block is stored, instead of re-reading the whole transcript every time
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      for (const block of e.message.content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          said.push(`- ${redact(block.text.trim()).slice(-SAID_CHARS).replace(/\s+/g, ' ')}`)
        }
      }
      if (said.length > 10) said = said.slice(-5)
    }
    return next(e)
  })

  // the card stays after the turn ends; only the person's click removes it
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) isRunning = false
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) isRunning = true
    log.push(`${e.agentId ? '(子任务) ' : ''}${brief(e.tool, e as unknown as Record<string, unknown>)}`)
    if (log.length > 60) log = log.slice(-30)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // what the plugins beneath drew (or nothing): ours goes above it instead of replacing it
    const below = await next(e)
    const c = await read($, card)
    if (e.props.hasSurvey || !c) return below

    const { Box, Button, Text, ...rest } = $.ui.resolve(e)
    const Svg = 'Svg' in rest ? rest.Svg : undefined // the desktop draws the mascot; other surfaces go without

    const done = async () => {
      const shown = (await read($, card)) ?? c
      try {
        const seen = await learned($)
        const kept = seen.filter(t => norm(t) !== norm(shown.title))
        await $.store.set(STORE_KEY, [...kept, shown.title].slice(-LEARNED_MAX))
      } catch {
        // not remembered: the same card may come round again, which is harmless
      }
      isStopped = false // the person is reading again: the next card may be made
      lastAt = 0 // and it is due as soon as the turn has run long enough
      await update($, card, () => null)
    }

    const mine = (
      <Box flexDirection="row" paddingX={1} gap={1} alignItems="center">
        {Svg && <Svg source={CLAWD} alt="Clawd 吉祥物，戴着学士帽，举着教鞭，旁边有一个亮着的灯泡" width={104} />}
        <Text dimColor>◀</Text>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" minHeight={2}>
            <Text bold>{c.title}</Text>
            <Button key="learned" label="我知道啦" onPress={done} />
          </Box>
          <Text>{c.explain}</Text>
          {c.example && (
            <Text dimColor>
              <Text color="blue" bold>例</Text>
              {`  ${c.example}`}
            </Text>
          )}
        </Box>
      </Box>
    )

    return below ? <Box flexDirection="column">{mine}{below}</Box> : mine
  })
}
