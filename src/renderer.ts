import i18next from 'i18next';

import { startingPages } from './providers/extracted-data';
import setupSongInfo from './providers/song-info-front';
import {
  createContext,
  forceLoadRendererPlugin,
  forceUnloadRendererPlugin,
  getAllLoadedRendererPlugins,
  getLoadedRendererPlugin,
  loadAllRendererPlugins,
} from './loader/renderer';

import { loadI18n, setLanguage, t as i18t } from '@/i18n';

import type { PluginConfig } from '@/types/plugins';
import type { YoutubePlayer } from '@/types/youtube-player';

let api: (Element & YoutubePlayer) | null = null;
let isPluginLoaded = false;
let isApiLoaded = false;
let firstDataLoaded = false;

async function listenForApiLoad() {
  if (!isApiLoaded) {
    api = document.querySelector('#movie_player');
    if (api) {
      await onApiLoaded();

      return;
    }
  }
}

interface YouTubeMusicAppElement extends HTMLElement {
  navigate_(page: string): void;
}

async function onApiLoaded() {
  window.ipcRenderer.on('seekTo', (_, t: number) => api!.seekTo(t));
  window.ipcRenderer.on('seekBy', (_, t: number) => api!.seekBy(t));

  const video = document.querySelector('video')!;
  const audioContext = new AudioContext();
  const audioSource = audioContext.createMediaElementSource(video);
  audioSource.connect(audioContext.destination);

  for await (const [id, plugin] of Object.entries(
    getAllLoadedRendererPlugins(),
  )) {
    if (typeof plugin.renderer !== 'function') {
      await plugin.renderer?.onPlayerApiReady?.call(
        plugin.renderer,
        api!,
        createContext(id),
      );
    }
  }

  if (firstDataLoaded) {
    document.dispatchEvent(
      new CustomEvent('videodatachange', { detail: { name: 'dataloaded' } }),
    );
  }

  const audioCanPlayEventDispatcher = () => {
    document.dispatchEvent(
      new CustomEvent('audioCanPlay', {
        detail: {
          audioContext,
          audioSource,
        },
      }),
    );
  };

  const loadstartListener = () => {
    // Emit "audioCanPlay" for each video
    video.addEventListener('canplaythrough', audioCanPlayEventDispatcher, {
      once: true,
    });
  };

  if (video.readyState === 4 /* HAVE_ENOUGH_DATA (loaded) */) {
    audioCanPlayEventDispatcher();
  }

  video.addEventListener('loadstart', loadstartListener, { passive: true });

  window.ipcRenderer.send('ytmd:player-api-loaded');

  // Navigate to "Starting page"
  const startingPage: string = window.mainConfig.get('options.startingPage');
  if (startingPage && startingPages[startingPage]) {
    document
      .querySelector<YouTubeMusicAppElement>('ytmusic-app')
      ?.navigate_(startingPages[startingPage]);
  }

  // Remove upgrade button
  if (window.mainConfig.get('options.removeUpgradeButton')) {
    const styles = document.createElement('style');
    styles.innerHTML = `ytmusic-guide-section-renderer #items ytmusic-guide-entry-renderer:last-child {
      display: none;
    }`;
    document.head.appendChild(styles);
  }

  // Hide / Force show like buttons
  const likeButtonsOptions: string = window.mainConfig.get(
    'options.likeButtons',
  );
  if (likeButtonsOptions) {
    const likeButtons: HTMLElement | null = document.querySelector(
      'ytmusic-like-button-renderer',
    );
    if (likeButtons) {
      likeButtons.style.display =
        {
          hide: 'none',
          force: 'inherit',
        }[likeButtonsOptions] || '';
    }
  }
}

/**
 * YouTube Music still using ES5, so we need to define custom elements using ES5 style
 */
const defineYTMDTransElements = () => {
  const YTMDTrans = function () {};
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  YTMDTrans.prototype = Object.create(HTMLElement.prototype);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  YTMDTrans.prototype.connectedCallback = function () {
    const that = this as HTMLElement;
    const key = that.getAttribute('key');
    if (key) {
      that.innerHTML = i18t(key);
    }
  };
  customElements.define(
    'ytmd-trans',
    YTMDTrans as unknown as CustomElementConstructor,
  );
};

const preload = async () => {
  await loadI18n();
  await setLanguage(window.mainConfig.get('options.language') ?? 'en');
  window.i18n = {
    t: i18t.bind(i18next),
  };
  defineYTMDTransElements();
};

const main = async () => {
  await loadAllRendererPlugins();
  isPluginLoaded = true;

  window.ipcRenderer.on('plugin:unload', async (_event, id: string) => {
    await forceUnloadRendererPlugin(id);
  });
  window.ipcRenderer.on('plugin:enable', async (_event, id: string) => {
    await forceLoadRendererPlugin(id);
    if (api) {
      const plugin = getLoadedRendererPlugin(id);
      if (plugin && typeof plugin.renderer !== 'function') {
        await plugin.renderer?.onPlayerApiReady?.call(
          plugin.renderer,
          api,
          createContext(id),
        );
      }
    }
  });

  window.ipcRenderer.on(
    'config-changed',
    (_event, id: string, newConfig: PluginConfig) => {
      const plugin = getAllLoadedRendererPlugins()[id];
      if (plugin && typeof plugin.renderer !== 'function') {
        plugin.renderer?.onConfigChange?.call(plugin.renderer, newConfig);
      }
    },
  );

  // Wait for complete load of YouTube api
  await listenForApiLoad();

  // Blocks the "Are You Still There?" popup by setting the last active time to Date.now every 15min
  setInterval(() => (window._lact = Date.now()), 900_000);

  // Setup back to front logger
  if (window.electronIs.dev()) {
    window.ipcRenderer.on('log', (_event, log: string) => {
      console.log(JSON.parse(log));
    });
  }
};

const initObserver = async () => {
  // check document.documentElement is ready
  await new Promise<void>((resolve) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    } else {
      resolve();
    }
  });

  const observer = new MutationObserver(() => {
    const playerApi = document.querySelector<Element & YoutubePlayer>(
      '#movie_player',
    );
    if (playerApi) {
      observer.disconnect();

      // Inject song-info provider
      setupSongInfo(playerApi);
      const dataLoadedListener = (name: string) => {
        if (!firstDataLoaded && name === 'dataloaded') {
          firstDataLoaded = true;
          playerApi.removeEventListener('videodatachange', dataLoadedListener);
        }
      };
      playerApi.addEventListener('videodatachange', dataLoadedListener);

      if (isPluginLoaded && !isApiLoaded) {
        api = playerApi;
        isApiLoaded = true;

        onApiLoaded();
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
};

initObserver().then(preload).then(main);
