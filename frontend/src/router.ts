import { GamePage } from './pages/game';
import { StartPage } from './pages/start';
import { ServerGatePage } from './pages/server-gate';
import { View } from './base-view';
import { getState } from './store';

// Simple router to handle / and /#/game/:id
let currentView: View | null = null;

export const render = () => {
  const hash = window.location.hash;
  const app = document.getElementById('app');
  if (!app) return;

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
  window.location.hash = path;
};

/** Force a full re-render regardless of hash change */
export const forceRender = () => {
  const hash = window.location.hash;
  const app = document.getElementById('app');
  if (!app) return;

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
