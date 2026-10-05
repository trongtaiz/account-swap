// The account list drawn on the hint line under the prompt; '' draws nothing.
export type Hint = string

declare module 'claude-code' {
  interface PluginState {
    // label: the row under the hint line while a token overrides the login; '' draws nothing.
    'account-swap': { hint: Hint; label: Hint }
  }
}
