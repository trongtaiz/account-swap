import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

type Engine = EngineInterface
type Account = {
  email: string
  // The whole credentials file as Claude Code wrote it; never parsed.
  creds: string
  oauthAccount: unknown
  // The rate-limit windows last seen while this account was active.
  usage?: SessionRateLimit[]
}

const THRESHOLD = 90
const COOLDOWN_MS = 5 * 60_000
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const hint = atom({ plugin: 'account-swap', key: 'hint' } as const, '')
const label = atom({ plugin: 'account-swap', key: 'label' } as const, '')
const PICKER = 'swap'

async function paths($: Engine) {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (dir === undefined && home === undefined) throw new Error('cannot find the home directory')
  const configDir = dir ?? `${home}/.claude`
  return {
    creds: `${configDir}/.credentials.json`,
    config: dir === undefined ? `${home}/.claude.json` : `${dir}/.claude.json`,
  }
}

async function readConfig($: Engine) {
  return JSON.parse(await $.fs.read((await paths($)).config)) as Record<string, unknown>
}

function emailOf(config: Record<string, unknown>) {
  const account = config.oauthAccount as { emailAddress?: string } | undefined
  return account?.emailAddress
}

async function readLive($: Engine) {
  const p = await paths($)
  const creds = await $.fs.read(p.creds).catch(() => {
    throw new Error('no live login (run /login first)')
  })
  const config = await readConfig($)
  const email = emailOf(config)
  if (email === undefined) throw new Error('the live login has no account email in .claude.json')
  return { creds, oauthAccount: config.oauthAccount, email }
}

async function loadAccounts($: Engine) {
  return ((await $.store.get('accounts')) as Account[] | undefined) ?? []
}

function formatUsage(usage: readonly SessionRateLimit[] | undefined) {
  return (usage ?? []).map(w => `${LABELS[w.kind] ?? w.kind} ${Math.round(w.percentUsed)}%`).join(' · ')
}

// Both outrank the /login credential this mod swaps, and Claude Code keeps the
// credential it read at the first request, so a swap under either would do nothing.
async function overriddenBy($: Engine) {
  if (await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')) return 'CLAUDE_CODE_OAUTH_TOKEN'
  if (await $.env.get('ANTHROPIC_AUTH_TOKEN')) return 'ANTHROPIC_AUTH_TOKEN'
}

// The hint line under the prompt: every account, the active one starred, each with
// its fullest window as last seen.
function hintText(accounts: readonly Account[], active: string | undefined, usage?: readonly SessionRateLimit[]) {
  if (accounts.length === 0) return ''
  const rows = accounts.map((a, i) => {
    const seen = a.email === active ? (usage ?? a.usage) : a.usage
    const pct = seen?.length ? ` ${Math.round(Math.max(...seen.map(w => w.percentUsed)))}%` : ''
    const label = `${i + 1} ${a.email}${pct}`
    return a.email === active ? `*${label}*` : label
  })
  return `swap: ${rows.join(' · ')}`
}

// Everything the mod shows rides the existing hint line: a $.ui.status notice is a
// block of its own, with rows of spacing around it.
async function refreshHint($: Engine, email: string | undefined, usage?: readonly SessionRateLimit[]) {
  const override = await overriddenBy($)
  const accounts = await loadAccounts($)
  await update($, hint, () => (override === undefined ? hintText(accounts, email, usage) : ''))
  await update($, label, () => (override === undefined ? labelText(accounts, email, usage) : `swap off (${override})`))
}

// The label under the hint line: the account in use, a token account by its
// name alone.
function labelText(accounts: readonly Account[], active: string | undefined, usage?: readonly SessionRateLimit[]) {
  const account = accounts.find(a => a.email === active)
  if (account === undefined) return ''
  const seen = usage ?? account.usage
  const pct = seen?.length ? ` ${Math.round(Math.max(...seen.map(w => w.percentUsed)))}%` : ''
  return `swap: ${account.email.replace(/@token\.local$/, '')}${pct}`
}

async function addLive($: Engine) {
  const live = await readLive($)
  const accounts = await loadAccounts($)
  const i = accounts.findIndex(a => a.email === live.email)
  const saved: Account = { ...accounts[i], email: live.email, creds: live.creds, oauthAccount: live.oauthAccount }
  if (i < 0) accounts.push(saved)
  else accounts[i] = saved
  await $.store.set('accounts', accounts)
  return { email: live.email, isNew: i < 0 }
}

// A setup-token saved the way claude-swap's add-token does: wrapped as a login in
// Claude Code's credentials JSON (which it re-reads on change), under a stand-in
// identity, since the token carries no email. Taken from the session's
// environment so it is never typed into the transcript.
async function addToken($: Engine, name: string) {
  const token = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
  if (token === undefined) {
    throw new Error('start Claude Code with CLAUDE_CODE_OAUTH_TOKEN set to the setup-token, then run this again')
  }
  if (!token.startsWith('sk-ant-oat')) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not a setup-token (sk-ant-oat…)')
  const email = `${name}@token.local`
  const saved: Account = {
    email,
    creds: JSON.stringify({ claudeAiOauth: { accessToken: token, scopes: ['user:inference'] } }),
    oauthAccount: { emailAddress: email, accountUuid: '', organizationUuid: null, organizationName: null },
  }
  const accounts = await loadAccounts($)
  const i = accounts.findIndex(a => a.email === email)
  if (i < 0) accounts.push(saved)
  else accounts[i] = saved
  await $.store.set('accounts', accounts)
  return email
}

// The live login's refresh token rotates while Claude Code runs, so the outgoing
// account is re-saved from the live file first: its stored copy may already be dead.
async function swapTo($: Engine, targetEmail: string) {
  const override = await overriddenBy($)
  if (override !== undefined) {
    throw new Error(`${override} is set and outranks the login this mod swaps; unset it and restart Claude Code`)
  }
  const p = await paths($)
  // No credentials file (a machine that only ever used setup-tokens): nothing to save.
  const live = (await $.fs.exists(p.creds)) ? await readLive($) : undefined
  if (live?.email === targetEmail) return `${targetEmail} is already active.`
  const outgoing = live === undefined ? 'no login' : (await addLive($)).email
  const target = (await loadAccounts($)).find(a => a.email === targetEmail)
  if (target === undefined) throw new Error(`no saved account ${targetEmail}`)

  await $.fs.write(p.creds, target.creds)
  try {
    const config = await readConfig($)
    await $.fs.write(p.config, JSON.stringify({ ...config, oauthAccount: target.oauthAccount }, null, 2))
  } catch (err) {
    if (live !== undefined) await $.fs.write(p.creds, live.creds)
    throw err
  }
  await $.store.set('lastSwapAt', await $.clock.now())
  await refreshHint($, targetEmail)
  return `Swapped ${outgoing} → ${targetEmail}. Takes effect on the next request.`
}

function isFull(account: Account, now: number) {
  return (account.usage ?? []).some(
    w => w.percentUsed >= THRESHOLD && (w.resetsAt === undefined || Date.parse(w.resetsAt) > now),
  )
}

function listText(accounts: readonly Account[], active: string | undefined, isAuto: boolean) {
  if (accounts.length === 0) return 'No saved accounts. Log in, then run /swap add.'
  const rows = accounts.map((a, i) => {
    const usage = formatUsage(a.usage)
    return `${a.email === active ? '*' : ' '} ${i + 1}. ${a.email}${usage ? `  (${usage} last seen)` : ''}`
  })
  return [...rows, `auto-swap: ${isAuto ? `on at ${THRESHOLD}%` : 'off'}`].join('\n')
}

async function runCommand($: Engine, args: string) {
  const [verb = 'list', arg, ...extra] = args.trim().split(/\s+/).filter(Boolean)
  const accounts = await loadAccounts($)
  const active = await readConfig($).then(emailOf, () => undefined)

  switch (verb) {
    case 'list':
      return listText(accounts, active, (await $.store.get('auto')) !== false)
    case 'add': {
      const { email, isNew } = await addLive($)
      await refreshHint($, email)
      return `${isNew ? 'Saved' : 'Updated'} ${email}. Run /login for another account, then /swap add again.`
    }
    case 'add-token': {
      if (arg === undefined || extra.length > 0 || !/^[\w.-]+$/.test(arg)) {
        throw new Error('usage: /swap add-token <name> (letters, digits, . _ -)')
      }
      const email = await addToken($, arg)
      await refreshHint($, active)
      return `Saved ${email}. Remove CLAUDE_CODE_OAUTH_TOKEN from your shell profiles and restart Claude Code, then /swap to switch to it.`
    }
    case 'use': {
      const target = accounts[Number(arg) - 1] ?? accounts.find(a => a.email === arg)
      if (target === undefined) throw new Error(`no saved account "${arg ?? ''}"`)
      return swapTo($, target.email)
    }
    case 'next': {
      if (accounts.length < 2) throw new Error('save at least two accounts first')
      const i = accounts.findIndex(a => a.email === active)
      return swapTo($, accounts[(i + 1) % accounts.length]!.email)
    }
    case 'remove': {
      const target = accounts[Number(arg) - 1]
      if (target === undefined) throw new Error(`no saved account #${arg ?? ''}`)
      await $.store.set('accounts', accounts.filter(a => a !== target))
      await refreshHint($, active)
      return `Removed ${target.email} (the live login is untouched).`
    }
    case 'auto':
      if (arg !== 'on' && arg !== 'off') throw new Error('usage: /swap auto on|off')
      await $.store.set('auto', arg === 'on')
      return `auto-swap ${arg}.`
    default:
      throw new Error('usage: /swap [list|add|add-token <name>|use <n|email>|next|remove <n>|auto on|off]')
  }
}

async function onUsage($: Engine, usage: readonly SessionRateLimit[]) {
  // The figures are the overriding credential's, not any saved account's.
  if ((await overriddenBy($)) !== undefined) return refreshHint($, undefined)
  const config = await readConfig($)
  const active = emailOf(config)
  const accounts = await loadAccounts($)
  const i = accounts.findIndex(a => a.email === active)
  const account = accounts[i]
  if (account === undefined) return refreshHint($, active, usage)

  accounts[i] = { ...account, usage: [...usage] }
  await $.store.set('accounts', accounts)
  await refreshHint($, active, usage)

  const now = await $.clock.now()
  const lastSwapAt = ((await $.store.get('lastSwapAt')) as number | undefined) ?? 0
  const isOver = usage.some(w => w.percentUsed >= THRESHOLD)
  if (!isOver || (await $.store.get('auto')) === false || now - lastSwapAt < COOLDOWN_MS) return

  const next = [...accounts.slice(i + 1), ...accounts.slice(0, i)].find(a => !isFull(a, now))
  if (next === undefined) {
    await $.store.set('lastSwapAt', now)
    return $.ui.toast(`swap: ${active} is at ${THRESHOLD}%+ and every saved account is near its limit.`)
  }
  $.ui.toast(await swapTo($, next.email))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'swap',
      description: 'Switch between saved Claude accounts',
      argumentHint: '[list|add|add-token <name>|use <n|email>|next|remove <n>|auto on|off]',
    })
    // 0.1 pinned a status notice; a reload keeps it until someone clears it.
    $.ui.status(undefined)
    await refreshHint($, await readConfig($).then(emailOf, () => undefined)).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'swap' }, async ($, e) => {
    try {
      if (e.args.trim() === '') {
        const rows = (await loadAccounts($)).length + 3
        const opened = await $.ui.open({ id: PICKER, title: 'Switch account', focus: true, closeOnEscape: true, holdToasts: true, rows })
        if (opened.isPlaced) return {}
      }
      return { text: await runCommand($, e.args) }
    } catch (err) {
      return { text: `swap: ${(err as Error).message}` }
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      await onUsage($, e.rateLimits).catch(err => $.ui.toast(`swap: ${(err as Error).message}`))
    }
    return next(e)
  })

  // The /swap picker, drawn like /model's: one row per account, the active one
  // focused, a digit or Enter switches, Esc closes.
  on('ui.render', { component: 'Pane', requestId: PICKER }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const accounts = await loadAccounts($)
    const active = await readConfig($).then(emailOf, () => undefined)
    const override = await overriddenBy($)
    const closeThen = (work: () => Promise<string>) => async () => {
      await $.ui.close({ id: PICKER })
      $.ui.toast(await work().catch(err => `swap: ${(err as Error).message}`))
    }

    return (
      <Box flexDirection="column">
        {override !== undefined && <Text dimColor>{override} is set: switching is off.</Text>}
        {accounts.length === 0 && <Text dimColor>No saved accounts yet.</Text>}
        {accounts.map((a, i) => {
          const usage = formatUsage(a.usage)
          const isActive = a.email === active
          return (
            <Button
              key={`account-${i + 1}`}
              plain
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              {...(isActive ? { autoFocus: true as const } : {})}
              label={`${a.email}${usage ? ` · ${usage}` : ''}${isActive ? '  ✔' : ''}`}
              onPress={closeThen(() => swapTo($, a.email))}
            />
          )
        })}
        {active !== undefined && !accounts.some(a => a.email === active) && (
          <Button
            key="save"
            plain
            hotkey="a"
            label={`Save current login (${active})`}
            onPress={closeThen(async () => {
              const { email } = await addLive($)
              await refreshHint($, email)
              return `Saved ${email}.`
            })}
          />
        )}
        <Text dimColor>Enter to switch · Esc to close</Text>
      </Box>
    )
  })

  // The line under the prompt: the engine's hint line, which `next` hands back for
  // the engine to keep drawing live, then the account in use on its own row in
  // colour (the engine draws its node first wherever it sits, and refuses it under
  // a Box that sets a width).
  // The account list rides the hint's tail only while idle, so "esc to
  // interrupt" is never crowded out.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const list = await read($, hint)
    const active = await read($, label)
    const isIdle = !e.props.isDraft && !e.props.isWorking
    const engine = await next(list !== '' && isIdle ? { ...e, props: { ...e.props, tail: list } } : e)
    if (active === '') return engine
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {engine}
        <Text color={active.startsWith('swap off') ? 'yellow' : 'cyan'} bold>
          {active}
        </Text>
      </Box>
    )
  })
}
