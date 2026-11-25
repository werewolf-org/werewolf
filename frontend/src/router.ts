import { GamePage } from './pages/game';
import { StartPage } from './pages/start';
import { ServerGatePage } from './pages/server-gate';
import { View } from './base-view';
import { getState } from './store';

// Simple router to handle / and /#/game/:id
let currentView: View | null = null;

// Tap-through guard. A fast double tap on one screen can deliver its second click to
// whatever the NEXT screen renders in the same place - in practice "Create Game" then
// "Close Joining", which closes the lobby with one player and shows an error. Clicks are
// swallowed in the capture phase for a moment after a route change; the first tap has
// already done its work by then.
const TAP_THROUGH_WINDOW_MS = 400;
let ignoreClicksUntil = 0;
let guardTimer: number | null = null;

document.addEventListener(
  'click',
  (event) => {
    if (Date.now() >= ignoreClicksUntil) return;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);

const armTapThroughGuard = () => {
  ignoreClicksUntil = Date.now() + TAP_THROUGH_WINDOW_MS;
  // Mirrored on <html> so tooling (and a curious human in the console) can tell whether
  // input is currently being ignored, instead of guessing with a sleep.
  document.documentElement.dataset.tapGuard = 'armed';
  if (guardTimer !== null) window.clearTimeout(guardTimer);
  guardTimer = window.setTimeout(() => {
    document.documentElement.dataset.tapGuard = 'ready';
    guardTimer = null;
  }, TAP_THROUGH_WINDOW_MS);
};

export const render = () => {
  const hash = window.location.hash;
  const app = document.getElementById('app');
  if (!app) return;

  // Only arm when replacing an existing view. The very first paint is not a tap-through,
  // and swallowing the first tap of a freshly loaded page looks like a dead button.
  if (currentView) armTapThroughGuard();

  // Cleanup previous view
  if (currentView) {
    currentView.unmount();
  }
  currentView = null;

  app.innerHTML = ''; // Clear current content

  // Route: Root / Start Page
  if (!hash || hash === '' || hash === '#/') {
    currentView = new StartPage();
    currentView.mount(app);
    return;
  }

  // Route: Game Page (e.g. #/game/ABCD)
  const gameMatch = hash.match(/^#\/game\/([a-zA-Z0-9]+)$/);
  if (gameMatch) {
    const gameId = gameMatch[1];

    // If socket not yet connected, show the cold-start gate first
    if (!getState().isConnected) {
      currentView = new ServerGatePage(gameId);
      currentView.mount(app);
      return;
    }

    // Instantiate the GamePage (Controller for phases)
    currentView = new GamePage(gameId); 
    currentView.mount(app);
    
    return;
  }

  // 404 - Redirect to home
  window.location.hash = '/';
};

export const navigate = (path: string) => {
  if (window.location.hash === path) {
    // Hash is already the same, but we may need to re-render
    // (e.g. switching from ServerGatePage to GamePage on the same route)
    render();
  } else {
    window.location.hash = path;
  }
};

/** Force a full re-render regardless of hash change */
export const forceRender = () => {
  const hash = window.location.hash;
  const app = document.getElementById('app');
  if (!app) return;

  armTapThroughGuard();

  if (currentView) {
    currentView.unmount();
  }
  currentView = null;

  app.innerHTML = '';

  if (!hash || hash === '' || hash === '#/') {
    currentView = new StartPage();
    currentView.mount(app);
    return;
  }

  const gameMatch = hash.match(/^#\/game\/([a-zA-Z0-9]+)$/);
  if (gameMatch) {
    const gameId = gameMatch[1];
    if (!getState().isConnected) {
      currentView = new ServerGatePage(gameId);
      currentView.mount(app);
      return;
    }
    currentView = new GamePage(gameId);
    currentView.mount(app);
    return;
  }

  window.location.hash = '/';
};
