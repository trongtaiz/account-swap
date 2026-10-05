import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const CREDS = 'C:/u/.claude/.credentials.json'
const CONFIG = 'C:/u/.claude.json'

// A fake disk, the env and the store beneath the plugin: no real credential is read.
function world(on: On, store: Record<string, unknown> = {}, vars: Record<string, string> = {}) {
  const files: Record<string, string> = {}
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  // Editable mid-test, as when the person drops a variable from their profile.
  const env: Record<string, string | undefined> = { USERPROFILE: 'C:/u', ...vars }
  on('env.get', ($, e) => ({ value: env[e.name] }))
  mock.store(on, store)
  mock.clock(on, { now: 1_000_000 })
  // The engine hands paths on with the platform's separators.
  const key = (path: string) => path.replaceAll('\\', '/')
  on('fs.read', ($, e) => {
    const text = files[key(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: key(e.path) in files }))
  on('fs.write', ($, e) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const opened: { id: string; focus?: true; closeOnEscape?: true }[] = []
  const closed: string[] = []
  on('ui.open', ($, e) => (opened.push(e), { value: { isPlaced: true as const } }))
  on('ui.close', ($, e) => (closed.push(e.id), { value: undefined }))
  let tail: string | undefined
  // The engine answers its own drawing as an engine node, as core does.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    tail = e.props.tail
    return { type: 'engine', ref: 0 } as RenderElement
  })
  // Draws the hint line under the prompt and answers what the mod added to it.
  const drawHint = async ($: Engine, isWorking = false) => {
    await $.ui.render({
      surface: 'terminal',
      component: 'PromptHint',
      requestId: 'hint',
      props: { isDraft: false, isWorking, hint: '? for shortcuts' },
    })
    return tail
  }
  // Draws the whole hint line and answers it as JSON: the mod's label, then the
  // engine's own line (here the stub above), whatever it wrapped them in.
  const drawLine = async ($: Engine) =>
    JSON.stringify(
      await $.ui.render({
        surface: 'terminal',
        component: 'PromptHint',
        requestId: 'line',
        props: { isDraft: true, isWorking: false, hint: '? for shortcuts' },
      }),
    )
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const login = (email: string, creds: string) => {
    files[CREDS] = creds
    files[CONFIG] = JSON.stringify({ oauthAccount: { emailAddress: email }, projects: { keep: 1 } })
  }
  const config = () => JSON.parse(files[CONFIG] ?? '{}')
  const activeEmail = () => config().oauthAccount.emailAddress
  return { files, env, toasts, statuses, opened, closed, drawHint, drawLine, login, config, activeEmail }
}

const swap = ($: Engine, args: string) =>
  $.command.run({
    command: 'swap',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

test('swapping back restores the rotated token, not the one saved at add', async ($, on) => {
  const w = world(on)
  w.login('a@x.com', 'CREDS-A1')
  await swap($, 'add')
  w.login('b@x.com', 'CREDS-B1')
  await swap($, 'add')
  w.files[CREDS] = 'CREDS-B2' // Claude Code refreshed B's token while it ran

  const toA = await swap($, 'use 1')
  expect(toA.text).toContain('b@x.com → a@x.com')
  expect(w.files[CREDS]).toBe('CREDS-A1')
  expect(w.activeEmail()).toBe('a@x.com')
  expect(w.config().projects).toEqual({ keep: 1 })

  await swap($, 'use b@x.com')
  expect(w.files[CREDS]).toBe('CREDS-B2')
})

test('auto-swap at the threshold skips an account seen full, then cools down', async ($, on) => {
  const account = (email: string, usage?: unknown) => ({
    email,
    creds: `CREDS-${email}`,
    oauthAccount: { emailAddress: email },
    usage,
  })
  const w = world(on, {
    accounts: [
      account('a@x.com'),
      account('b@x.com', [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2099-01-01T00:00:00Z' }]),
      account('c@x.com'),
    ],
  })
  w.login('a@x.com', 'CREDS-a@x.com')
  const measure = (percentUsed: number) =>
    $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed }],
      changed: ['rateLimits'],
    })

  await measure(50)
  expect(w.activeEmail()).toBe('a@x.com')

  await measure(92)
  expect(w.activeEmail()).toBe('c@x.com')
  expect(w.files[CREDS]).toBe('CREDS-c@x.com')
  expect(w.toasts.at(-1) ?? '').toContain('a@x.com → c@x.com')

  await measure(95) // c is over too, but inside the cooldown
  expect(w.activeEmail()).toBe('c@x.com')
})

test('a set CLAUDE_CODE_OAUTH_TOKEN outranks the login, so swaps refuse and say why', async ($, on) => {
  const account = (email: string) => ({ email, creds: `CREDS-${email}`, oauthAccount: { emailAddress: email } })
  const w = world(on, { accounts: [account('a@x.com'), account('b@x.com')] }, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
  w.login('a@x.com', 'CREDS-a@x.com')

  const result = await swap($, 'use 2')
  expect(result.text).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  expect(w.files[CREDS]).toBe('CREDS-a@x.com')

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 99 }],
    changed: ['rateLimits'],
  })
  expect(w.activeEmail()).toBe('a@x.com')
  expect(await w.drawLine($)).toContain('swap off (CLAUDE_CODE_OAUTH_TOKEN)')
  expect(w.statuses.filter(text => text !== undefined)).toEqual([]) // no ⚠ notice block
})

test('the hint line under the prompt lists every account, the active one starred', async ($, on) => {
  const account = (email: string, percentUsed?: number) => ({
    email,
    creds: `CREDS-${email}`,
    oauthAccount: { emailAddress: email },
    usage: percentUsed === undefined ? undefined : [{ kind: 'five_hour', percentUsed }],
  })
  const w = world(on, { accounts: [account('a@x.com', 64), account('b@x.com')] })
  w.login('b@x.com', 'CREDS-b@x.com')
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
    changed: ['rateLimits'],
  })
  expect(await w.drawHint($)).toBe('swap: 1 a@x.com 64% · *2 b@x.com 12%*')
  expect(await w.drawHint($, true)).toBeUndefined() // a turn runs: the engine's own line, untouched
})

const PICKER_PROPS = {
  title: 'Switch account',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const pickerAccount = (email: string) => ({ email, creds: `CREDS-${email}`, oauthAccount: { emailAddress: email } })

test('/swap alone opens a picker like /model, and pressing a row swaps to it', async ($, on) => {
  const w = world(on, { accounts: [pickerAccount('a@x.com'), pickerAccount('b@x.com')] })
  w.login('a@x.com', 'CREDS-a@x.com')

  const result = await swap($, '')
  expect(result.text).toBeUndefined()
  expect(w.opened[0]).toEqual(expect.objectContaining({ id: 'swap', focus: true, closeOnEscape: true }))

  const ui = await $.ui.mount({ plugin: 'account-swap', surface: 'terminal', component: 'Pane', requestId: 'swap', props: PICKER_PROPS })
  expect((await ui.find({ key: 'account-1' }))?.text ?? '').toContain('a@x.com')
  expect((await ui.find({ key: 'account-2' }))?.text ?? '').toContain('b@x.com')

  await ui.press({ key: 'account-2' })
  expect(w.activeEmail()).toBe('b@x.com')
  expect(w.closed).toEqual(['swap'])
})

test('the picker offers to save a login that is not saved yet', async ($, on) => {
  const w = world(on, { accounts: [pickerAccount('a@x.com')] })
  w.login('c@x.com', 'CREDS-c@x.com')

  const ui = await $.ui.mount({ plugin: 'account-swap', surface: 'terminal', component: 'Pane', requestId: 'swap', props: PICKER_PROPS })
  expect((await ui.find({ key: 'save' }))?.text ?? '').toContain('c@x.com')

  await ui.press({ key: 'save' })
  expect((await swap($, 'list')).text ?? '').toContain('2. c@x.com')
})

test("/swap add-token saves the session's setup-token as an account that swaps like a login", async ($, on) => {
  const w = world(on, { accounts: [pickerAccount('a@x.com')] }, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-WORK' })
  w.login('a@x.com', 'CREDS-a@x.com')

  const added = await swap($, 'add-token work')
  expect(added.text ?? '').toContain('work@token.local')
  expect(added.text ?? '').not.toContain('sk-ant-oat01-WORK')

  w.env.CLAUDE_CODE_OAUTH_TOKEN = undefined // dropped from the profile, Claude Code restarted
  await swap($, 'use 2')
  // claude-swap's own wrapping, which Claude Code reads as a login
  expect(JSON.parse(w.files[CREDS] ?? '{}')).toEqual({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-WORK', scopes: ['user:inference'] },
  })
  expect(w.activeEmail()).toBe('work@token.local')
  expect(w.config().projects).toEqual({ keep: 1 })

  await swap($, 'use 1')
  expect(w.files[CREDS]).toBe('CREDS-a@x.com')
})

test('/swap add-token refuses without a setup-token in the session, or with a bad name', async ($, on) => {
  const w = world(on, {}, {})
  w.login('a@x.com', 'CREDS-a@x.com')
  expect((await swap($, 'add-token work')).text ?? '').toContain('CLAUDE_CODE_OAUTH_TOKEN')

  w.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-api03-not-a-setup-token'
  expect((await swap($, 'add-token work')).text ?? '').toContain('not a setup-token')

  w.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-WORK'
  expect((await swap($, 'add-token')).text ?? '').toContain('usage: /swap add-token <name>')
  expect((await swap($, 'add-token a b')).text ?? '').toContain('usage: /swap add-token <name>')
})

test('a token-only machine with no login file yet can still swap to a saved token', async ($, on) => {
  const token = {
    email: 'work@token.local',
    creds: JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-WORK', scopes: ['user:inference'] } }),
    oauthAccount: { emailAddress: 'work@token.local' },
  }
  const w = world(on, { accounts: [token] })
  w.files[CONFIG] = JSON.stringify({ projects: { keep: 1 } }) // never ran /login: no .credentials.json

  const result = await swap($, 'use 1')
  expect(result.text ?? '').toContain('work@token.local')
  expect(w.files[CREDS]).toBe(token.creds)
  expect(w.activeEmail()).toBe('work@token.local')
})

test('a cyan label under the hint line says which account is in use', async ($, on) => {
  const token = {
    email: 'sonnd@token.local',
    creds: 'CREDS-sonnd',
    oauthAccount: { emailAddress: 'sonnd@token.local' },
    usage: [{ kind: 'five_hour', percentUsed: 12 }],
  }
  const w = world(on, { accounts: [pickerAccount('a@x.com'), token] })
  w.login('sonnd@token.local', 'CREDS-sonnd')
  await $.session.start({ cwd: 'D:/p', surface: 'terminal', isInteractive: true })
  // a column: the engine's own line, still drawn by the engine, then the label
  expect(await w.drawLine($)).toMatch(/"flexDirection":"column".*"type":"engine".*"color":"cyan".*"swap: sonnd 12%"/)
})

test('under a session token the label says swap is off, in yellow', async ($, on) => {
  const w = world(on, { accounts: [pickerAccount('a@x.com')] }, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-X' })
  w.login('a@x.com', 'CREDS-a@x.com')
  await $.session.start({ cwd: 'D:/p', surface: 'terminal', isInteractive: true })
  expect(await w.drawLine($)).toMatch(/"type":"engine".*"color":"yellow".*"swap off \(CLAUDE_CODE_OAUTH_TOKEN\)"/)
})

test('session start clears a status notice an older version of the mod pinned', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'D:/p', surface: 'terminal', isInteractive: true })
  expect(w.statuses).toEqual([undefined])
})
