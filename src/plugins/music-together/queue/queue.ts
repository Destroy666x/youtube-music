import { getMusicQueueRenderer } from './song';
import { mapQueueItem } from './utils';

import type { Profile, QueueAPI, VideoData } from '../types';
import { ConnectionEventUnion } from '@/plugins/music-together/connection';
import { t } from '@/i18n';

const getHeaderPayload = (() => {
  let payload: unknown = null;

  return () => {
    if (!payload) {
      payload = {
        title: {
          runs: [
            {
              text: t('plugins.music-together.internal.track-source')
            }
          ]
        },
        subtitle: {
          runs: [
            {
              text: t('plugins.music-together.name')
            }
          ]
        },
        buttons: [
          {
            chipCloudChipRenderer: {
              style: {
                styleType: 'STYLE_TRANSPARENT'
              },
              text: {
                runs: [
                  {
                    text: t('plugins.music-together.internal.save')
                  }
                ]
              },
              navigationEndpoint: {
                saveQueueToPlaylistCommand: {}
              },
              icon: {
                iconType: 'ADD_TO_PLAYLIST'
              },
              accessibilityData: {
                accessibilityData: {
                  label: t('plugins.music-together.internal.save')
                }
              },
              isSelected: false,
              uniqueId: t('plugins.music-together.internal.save')
            }
          }
        ]
      };
    }

    return payload;
  }
})();

export type QueueOptions = {
  videoList?: VideoData[];
  owner?: Profile;
  queue?: HTMLElement & QueueAPI;
  getProfile: (id: string) => Profile | undefined;
}
export type QueueEventListener = (event: ConnectionEventUnion) => void;

export class Queue {
  private queue: (HTMLElement & QueueAPI) | null = null;
  private originalDispatch: ((obj: {
    type: string;
    payload?: unknown;
  }) => void) | null = null;
  private internalDispatch = false;
  private ignoreFlag = false;
  private listeners: QueueEventListener[] = [];
  private owner: Profile | null = null;
  private getProfile: (id: string) => Profile | undefined;

  constructor(options: QueueOptions) {
    this.getProfile = options.getProfile;
    this.queue = options.queue ?? document.querySelector<HTMLElement & QueueAPI>('#queue');
    this.owner = options.owner ?? null;
    this._videoList = options.videoList ?? [];
  }

  private _videoList: VideoData[] = [];

  /* utils */
  get videoList() {
    return this._videoList;
  }

  get selectedIndex() {
    return mapQueueItem((it) => it?.selected, this.queue?.store.getState().queue.items).findIndex(Boolean) ?? 0;
  }

  get rawItems() {
    return this.queue?.store.getState().queue.items;
  }

  get flatItems() {
    return mapQueueItem((it) => it, this.rawItems);
  }

  setOwner(owner: Profile) {
    this.owner = owner;
  }

  /* public */
  async setVideoList(videoList: VideoData[], sync = true) {
    this._videoList = videoList;

    if (sync) await this.syncVideo();
  }

  async addVideos(videos: VideoData[], index?: number) {
    const response = await getMusicQueueRenderer(videos.map((it) => it.videoId));
    if (!response) return false;

    const items = response.queueDatas.map((it) => it?.content).filter(Boolean);
    if (!items) return false;

    this.internalDispatch = true;
    this._videoList.push(...videos);
    this.queue?.dispatch({
      type: 'ADD_ITEMS',
      payload: {
        nextQueueItemId: this.queue.store.getState().queue.nextQueueItemId,
        index: index ?? this.queue.store.getState().queue.items.length ?? 0,
        items,
        shuffleEnabled: false,
        shouldAssignIds: true
      }
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);

    return true;
  }

  async removeVideo(index: number) {
    this.internalDispatch = true;
    this._videoList.splice(index, 1);
    this.queue?.dispatch({
      type: 'REMOVE_ITEM',
      payload: index
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);
  }

  setIndex(index: number) {
    this.internalDispatch = true;
    this.queue?.dispatch({
      type: 'SET_INDEX',
      payload: index
    });
    this.internalDispatch = false;
  }

  moveItem(fromIndex: number, toIndex: number) {
    this.internalDispatch = true;
    const data = this._videoList.splice(fromIndex, 1)[0];
    this._videoList.splice(toIndex, 0, data);
    this.queue?.dispatch({
      type: 'MOVE_ITEM',
      payload: {
        fromIndex,
        toIndex
      }
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);
  }

  clear() {
    this.internalDispatch = true;
    this._videoList = [];
    this.queue?.dispatch({
      type: 'CLEAR'
    });
    this.internalDispatch = false;
  }

  on(listener: QueueEventListener) {
    this.listeners.push(listener);
  }

  off(listener: QueueEventListener) {
    this.listeners = this.listeners.filter((it) => it !== listener);
  }

  rollbackInjection() {
    if (!this.queue) {
      console.error('Queue is not initialized!');
      return;
    }

    if (this.originalDispatch) this.queue.store.dispatch = this.originalDispatch;
  }

  injection() {
    if (!this.queue) {
      console.error('Queue is not initialized!');
      return;
    }

    this.originalDispatch = this.queue.store.dispatch;
    this.queue.store.dispatch = (event) => {
      if (!this.queue || !this.owner) {
        console.error('Queue is not initialized!');
        return;
      }

      if (!this.internalDispatch) {
        if (event.type === 'CLEAR') {
          this.ignoreFlag = true;
        }
        if (event.type === 'ADD_ITEMS') {
          if (this.ignoreFlag) {
            this.ignoreFlag = false;
            const videoList = mapQueueItem((it: any) => ({
              videoId: it.videoId,
              ownerId: this.owner!.id
            } satisfies VideoData), (event.payload as any).items);
            const index = this._videoList.length + videoList.length - 1;

            if (videoList.length > 0) {
              this.broadcast({ // play
                type: 'ADD_SONGS',
                payload: {
                  videoList
                },
                after: [
                  {
                    type: 'SYNC_PROGRESS',
                    payload: {
                      index
                    }
                  }
                ]
              });
            }
          } else if ((event.payload as any).items.length === 1) {
            this.broadcast({ // add playlist
              type: 'ADD_SONGS',
              payload: {
                // index: (event.payload as any).index,
                videoList: mapQueueItem((it: any) => ({
                  videoId: it.videoId,
                  ownerId: this.owner!.id
                } satisfies VideoData), (event.payload as any).items)
              }
            });
          }

          return;
        }

        if (event.type === 'MOVE_ITEM') {
          this.broadcast({
            type: 'MOVE_SONG',
            payload: {
              fromIndex: (event.payload as any).fromIndex,
              toIndex: (event.payload as any).toIndex
            }
          });
          return;
        }
        if (event.type === 'REMOVE_ITEM') {
          this.broadcast({
            type: 'REMOVE_SONG',
            payload: {
              index: event.payload as number
            }
          });
          return;
        }
        if (event.type === 'SET_INDEX') {
          this.broadcast({
            type: 'SYNC_PROGRESS',
            payload: {
              index: event.payload as number
            }
          });
          return;
        }

        if (event.type === 'SET_HEADER') event.payload = getHeaderPayload();
        if (event.type === 'ADD_STEERING_CHIPS') {
          event.type = 'CLEAR_STEERING_CHIPS';
          event.payload = undefined;
        }
        if (event.type === 'SET_PLAYER_UI_STATE') {
          if (event.payload === 'INACTIVE' && this.videoList.length > 0) {
            return;
          }
        }
        if (event.type === 'HAS_SHOWN_AUTOPLAY') return;
        if (event.type === 'ADD_AUTOMIX_ITEMS') return;
      }

      const fakeContext = {
        ...this.queue,
        store: {
          ...this.queue.store,
          dispatch: this.originalDispatch
        }
      };
      this.originalDispatch!.call(fakeContext, event);
    };
  }

  /* sync */
  async initQueue() {
    if (!this.queue) return;

    this.internalDispatch = true;
    this.queue.dispatch({
      type: 'HAS_SHOWN_AUTOPLAY',
      payload: false
    });
    this.queue.dispatch({
      type: 'SET_HEADER',
      payload: getHeaderPayload(),
    });
    this.queue.dispatch({
      type: 'CLEAR_STEERING_CHIPS'
    });
    this.internalDispatch = false;
  }

  async syncVideo() {
    const response = await getMusicQueueRenderer(this._videoList.map((it) => it.videoId));
    if (!response) return false;

    const items = response.queueDatas.map((it) => it.content);

    this.internalDispatch = true;
    this.queue?.dispatch({
      type: 'UPDATE_ITEMS',
      payload: {
        items: items,
        nextQueueItemId: this.queue.store.getState().queue.nextQueueItemId,
        shouldAssignIds: true,
        currentIndex: -1
      }
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);

    return true;
  }

  async syncQueueOwner() {
    const allQueue = document.querySelectorAll('#queue');

    allQueue.forEach((queue) => {
      const list = Array.from(queue?.querySelectorAll<HTMLElement>('ytmusic-player-queue-item') ?? []);

      list.forEach((item, index) => {
        if (typeof index !== 'number') return;

        const id = this._videoList[index]?.ownerId;
        const data = this.getProfile(id);

        const profile = item.querySelector<HTMLImageElement>('.music-together-owner') ?? document.createElement('img');
        profile.classList.add('music-together-owner');
        profile.dataset.id = id;
        profile.dataset.index = index.toString();

        const name = item.querySelector<HTMLElement>('.music-together-name') ?? document.createElement('div');
        name.classList.add('music-together-name');
        name.textContent = data?.name ?? t('plugins.music-together.internal.unknown-user');

        if (data) {
          profile.dataset.thumbnail = data.thumbnail ?? '';
          profile.dataset.name = data.name ?? '';
          profile.dataset.handleId = data.handleId ?? '';
          profile.dataset.id = data.id ?? '';

          profile.src = data.thumbnail ?? '';
          profile.title = data.name ?? '';
          profile.alt = data.handleId ?? '';
        }

        if (!profile.isConnected) item.append(profile);
        if (!name.isConnected) item.append(name);
      });
    });
  }

  removeQueueOwner() {
    const allQueue = document.querySelectorAll('#queue');

    allQueue.forEach((queue) => {
      const list = Array.from(queue?.querySelectorAll<HTMLElement>('ytmusic-player-queue-item') ?? []);

      list.forEach((item) => {
        const profile = item.querySelector<HTMLImageElement>('.music-together-owner');
        const name = item.querySelector<HTMLElement>('.music-together-name');
        profile?.remove();
        name?.remove();
      });
    });
  }

  /* private */
  private broadcast(event: ConnectionEventUnion) {
    this.listeners.forEach((listener) => listener(event));
  }
}
