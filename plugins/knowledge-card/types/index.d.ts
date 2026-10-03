export type Card = { title: string; explain: string; example: string }

declare module 'claude-code' {
  interface PluginState {
    'knowledge-card': { card: Card | null }
  }
}
