import { GameEngine } from './GameEngine';

export function App(): JSX.Element {
  return (
    <main className='app-shell'>
      <header className='top-bar'>
        <h1>Life Codex — Simulation temps réel</h1>
        <p>Moteur ECS + streaming de chunks + workers avec HUD Liquid Glass</p>
      </header>

      <section className='viewport-card'>
        <GameEngine />
      </section>
    </main>
  );
}
