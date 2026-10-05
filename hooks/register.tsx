import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Game } from '../types'

const pot = atom({ plugin: 'token-blackjack', key: 'pot' } as const, 0)
const emptyGame: Game = { phase: 'bet', deck: [], player: [], dealer: [], bet: 0, message: '' }
const isOpen = atom({ plugin: 'token-blackjack', key: 'isOpen' } as const, false)
const game = atom({ plugin: 'token-blackjack', key: 'game' } as const, emptyGame)

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const SUITS = ['♠', '♥', '♦', '♣']

const newDeck = (): string[] => {
  const deck = RANKS.flatMap(r => SUITS.map(s => r + s))

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }

  return deck
}

const value = (hand: string[]): number => {
  let total = 0
  let aces = 0

  for (const card of hand) {
    const rank = card.slice(0, -1)

    if (rank === 'A') {
      aces += 1
      total += 11
    } else {
      total += 'JQK'.includes(rank) ? 10 : Number(rank)
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }

  return total
}

const show = (hand: string[]) => hand.join(' ')

// The pot is kept in $.store; the state atom mirrors it for drawing.
async function addToPot($: EngineInterface, delta: number) {
  const stored = Number((await $.store.get('pot')) ?? 0)
  const total = Math.max(0, Math.max(stored, await read($, pot)) + delta)
  await $.store.set('pot', total)
  await update($, pot, () => total)
}


async function finish($: EngineInterface, g: Game, outcome: 'win' | 'lose' | 'push' | 'fold' | 'blackjack', note: string) {
  let delta = 0
  let verdict = ''

  if (outcome === 'win') {
    delta = g.bet
    verdict = `You win ${g.bet}!`
  } else if (outcome === 'blackjack') {
    delta = Math.floor(g.bet * 1.5)
    verdict = `Blackjack! You win ${delta}!`
  } else if (outcome === 'lose') {
    delta = -g.bet
    verdict = `You lose ${g.bet}.`
  } else if (outcome === 'fold') {
    delta = -Math.floor(g.bet / 2)
    verdict = `You fold and lose ${-delta}.`
  } else {
    verdict = 'Push. Your bet is returned.'
  }

  await addToPot($, delta)
  await update($, game, cur => ({ ...cur, phase: 'done', message: `${note} ${verdict}`.trim() }))
}

async function deal($: EngineInterface, bet: number) {
  const deck = newDeck()
  const player = [deck.pop()!, deck.pop()!]
  const dealer = [deck.pop()!, deck.pop()!]
  const g: Game = { phase: 'play', deck, player, dealer, bet, message: '' }
  await update($, game, () => g)

  const p = value(player)
  const d = value(dealer)

  if (p === 21 && d === 21) {
    await finish($, g, 'push', 'Both have blackjack.')
  } else if (p === 21) {
    await finish($, g, 'blackjack', '')
  } else if (d === 21) {
    await finish($, g, 'lose', 'Dealer has blackjack.')
  }
}

async function hit($: EngineInterface) {
  const g = await read($, game)

  if (g.phase !== 'play') return

  const deck = [...g.deck]
  const player = [...g.player, deck.pop()!]
  const next: Game = { ...g, deck, player }
  await update($, game, () => next)

  if (value(player) > 21) {
    await finish($, next, 'lose', 'Bust.')
  } else if (value(player) === 21) {
    await stay($)
  }
}

async function stay($: EngineInterface) {
  const g = await read($, game)

  if (g.phase !== 'play') return

  const deck = [...g.deck]
  const dealer = [...g.dealer]

  while (value(dealer) < 17) dealer.push(deck.pop()!)

  const next: Game = { ...g, deck, dealer }
  await update($, game, () => next)

  const p = value(g.player)
  const d = value(dealer)

  if (d > 21) await finish($, next, 'win', 'Dealer busts.')
  else if (p > d) await finish($, next, 'win', `${p} beats ${d}.`)
  else if (p < d) await finish($, next, 'lose', `Dealer's ${d} beats ${p}.`)
  else await finish($, next, 'push', `Both have ${p}.`)
}

async function fold($: EngineInterface) {
  const g = await read($, game)

  if (g.phase !== 'play') return

  await finish($, g, 'fold', '')
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = Number((await $.store.get('pot')) ?? 0)
    await update($, pot, current => Math.max(current, saved))
    await $.command.register({ name: 'blackjack', description: 'Play blackjack with your token pot' })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage

    if (!e.agentId && u) {
      await addToPot($, u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens)
    }

    return next(e)
  })

  on('command.run', { command: 'blackjack' }, async $ => {
    await update($, game, () => emptyGame)
    await update($, isOpen, () => true)

    return { text: 'Blackjack table opened above the prompt.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, isOpen))) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const money = await read($, pot)
    const g = await read($, game)
    const isHidden = g.phase === 'play'
    const dealerScore = isHidden ? value(g.dealer.slice(0, 1)) : value(g.dealer)
    const tone = g.message.includes('lose') || g.message.includes('Bust') ? 'red' : g.message.includes('Push') ? 'yellow' : 'green'

    const bets = [
      { key: 'b10', label: '10%', amount: Math.max(1, Math.floor(money * 0.1)) },
      { key: 'b50', label: '50%', amount: Math.max(1, Math.floor(money * 0.5)) },
      { key: 'ball', label: 'ALL IN', amount: money },
    ]

    const cards = (hand: string[], hideSecond: boolean) => (
      <Box>
        {hand.map((card, i) =>
          hideSecond && i > 0 ? (
            <Text key={`c${i}`} color="blue" backgroundColor="white"> ?? </Text>
          ) : (
            <Text key={`c${i}`} color={'♥♦'.includes(card.slice(-1)) ? 'red' : 'black'} backgroundColor="white"> {card} </Text>
          ),
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
        <Box>
          <Text bold color="green">♠ Token Blackjack ♥ </Text>
          <Text color="yellow" bold>Pot: {money.toLocaleString()}</Text>
        </Box>

        {g.phase === 'bet' && (
          <Box flexDirection="column">
            <Text color={money < 1 ? 'red' : 'cyan'}>{money < 1 ? 'Your pot is empty. Use some tokens, then come back.' : 'Place your bet:'}</Text>
            {money >= 1 && (
              <Box>
                {bets.map(b => (
                  <Button key={b.key} label={`${b.label} (${b.amount.toLocaleString()})`} variant={b.key === 'ball' ? 'primary' : undefined} onPress={() => deal($, b.amount)} />
                ))}
              </Box>
            )}
          </Box>
        )}

        {g.phase !== 'bet' && (
          <Box flexDirection="column">
            <Text color="yellow">Bet: {g.bet.toLocaleString()}</Text>
            <Box>
              <Text color="magenta" bold>Dealer ({dealerScore}) </Text>
              {cards(g.dealer, isHidden)}
            </Box>
            <Box>
              <Text color="cyan" bold>You ({value(g.player)}) </Text>
              {cards(g.player, false)}
            </Box>
          </Box>
        )}

        {g.phase === 'play' && (
          <Box>
            <Button key="hit" label="Hit" variant="primary" onPress={() => hit($)} />
            <Button key="stay" label="Stay" onPress={() => stay($)} />
            <Button key="fold" label="Fold" onPress={() => fold($)} />
          </Box>
        )}

        {g.phase === 'done' && (
          <Box flexDirection="column">
            <Text bold color={tone}>{g.message}</Text>
            <Box>
              <Button key="again" label="Play again" variant="primary" onPress={() => update($, game, () => emptyGame)} />
              <Button key="close" label="Close" role="dismiss" onPress={() => update($, isOpen, () => false)} />
            </Box>
          </Box>
        )}

        {g.phase !== 'done' && (
          <Button key="leave" label="Close" role="dismiss" dimColor onPress={() => update($, isOpen, () => false)} />
        )}
      </Box>
    )
  })
}
