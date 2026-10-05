export type Game = {
  phase: 'bet' | 'play' | 'done'
  deck: string[]
  player: string[]
  dealer: string[]
  bet: number
  message: string
}

declare module 'claude-code' {
  interface PluginState {
    'token-blackjack': { pot: number; isOpen: boolean; game: Game }
  }
}
