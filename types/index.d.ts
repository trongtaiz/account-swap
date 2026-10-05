// The account list drawn on the hint line under the prompt; '' draws nothing.
export type Hint = string

declare module 'claude-code' {
  interface PluginState {
    // label: the one mode label on the prompt footer naming the account in use.
    'account-swap': { hint: Hint; label: Hint }
  }
}
