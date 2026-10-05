# Account Swap

A Claude Code mod for switching between saved Claude accounts without leaving the session, with optional auto-swap before the active account hits its rate limit.

- `/swap` opens a picker, like `/model`'s, listing your saved accounts and their last-seen usage.
- The hint line under the prompt lists your accounts with the one in use starred, e.g. `swap: *1 work 42%* · 2 personal 10%`. While a token overrides the login, a yellow `swap off (…)` row appears under it.
- Auto-swap: when the active account reaches 90% of its 5-hour or weekly limit, the mod switches to the next saved account that isn't near its limit (at most once every 5 minutes).

## Install

```sh
claude plugin marketplace add trongtaiz/account-swap
claude plugin install account-swap@account-swap
```

Then start a new session, or run `/reload-plugins` in an open one.

## Usage

| Command | What it does |
| --- | --- |
| `/swap` | Open the account picker (digit or Enter switches, Esc closes) |
| `/swap list` | List saved accounts as text |
| `/swap add` | Save the account you're logged in as now |
| `/swap add-token <name>` | Save the setup-token in `CLAUDE_CODE_OAUTH_TOKEN` as account `<name>` |
| `/swap use <n\|email>` | Switch to an account by number or email |
| `/swap next` | Switch to the next saved account |
| `/swap remove <n>` | Forget a saved account (the live login is untouched) |
| `/swap auto on\|off` | Turn auto-swap on or off (on by default) |

A swap takes effect on the next request; no restart is needed.

### Saving logged-in accounts

1. `/login` as the first account, then `/swap add`.
2. `/login` as the next account, then `/swap add`. Repeat for each account.

### Saving setup-tokens

1. Create a token with `claude setup-token`.
2. Start Claude Code with `CLAUDE_CODE_OAUTH_TOKEN` set to it, and run `/swap add-token <name>`. The token is read from the environment, so it never appears in the transcript.
3. Remove `CLAUDE_CODE_OAUTH_TOKEN` from your shell profile and restart Claude Code.

While `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` is set, it takes precedence over the login this mod swaps, so switching is off and the line under the prompt reads `swap off (…)` in yellow.

## Security: what this mod stores and writes

- **Every saved account's credentials, in plain text**, in Claude Code's plugin store: `~/.claude/plugins/store/account-swap_*.json`. That includes OAuth refresh tokens and setup-tokens. The file has the same permissions as Claude Code's own `~/.claude/.credentials.json`, but it holds a copy for every account, so treat it as a secret: don't sync or back up `~/.claude` anywhere you wouldn't put a password.
- **On a swap it overwrites** `~/.claude/.credentials.json` and the `oauthAccount` entry in `~/.claude.json` (or the same files under `CLAUDE_CONFIG_DIR`).
- It makes **no network requests**; usage figures come from Claude Code's own rate-limit reports.

`/swap remove <n>` deletes an account from the store. Uninstalling the plugin may not delete the store file, so delete it yourself if you stop using the mod.

## Platform support

Tested on Windows. It should work on Linux, which also keeps the login in `~/.claude/.credentials.json`. On macOS, Claude Code keeps the login in the Keychain, which this mod can't read or write, so it is unlikely to work there.

## Terms of use

Using several accounts to get around per-account rate limits may conflict with Anthropic's terms. Check them for your plan before turning on auto-swap.

## Development

```sh
claude plugin test .          # run the tests
claude plugin validate --strict .
```

## License

MIT
