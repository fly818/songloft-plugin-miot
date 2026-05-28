// MIoT 智能音箱插件 - 歌单播放 Handler
// 翻译自 Go 源码: plugins/mimusic-plugin-xiaomi/handlers/playlist_handler.go

import { jsonResponse, parseQuery } from '@mimusic/plugin-sdk';
import type { Router, HTTPRequest } from '@mimusic/plugin-sdk';
import { PlaylistManagerMap } from '../player/manager';
import { MinaService } from '../service/service';
import { ConfigManager } from '../config/manager';
import type { PlayMode } from '../types';

/** 解析请求体（兼容 Uint8Array 和 string） */
function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/** 判断是否为本地回环地址 */
function isLoopbackAddress(host: string): boolean {
  if (!host) return false;
  let hostname = host;
  const protoIdx = host.indexOf('://');
  if (protoIdx >= 0) {
    const rest = host.slice(protoIdx + 3);
    const slashIdx = rest.indexOf('/');
    const colonIdx = rest.indexOf(':');
    hostname = rest.slice(0, slashIdx >= 0 ? slashIdx : (colonIdx >= 0 ? colonIdx : undefined));
  }
  hostname = hostname.toLowerCase().trim();
  return hostname === 'localhost' || hostname.startsWith('127.') || hostname === '::1';
}

/**
 * 注册歌单播放相关路由
 * GET  /playlists            → 获取歌单列表
 * GET  /playlists/:id/songs  → 获取歌单歌曲
 * POST /player/play          → 播放歌单
 * POST /player/stop          → 停止播放
 * POST /player/previous      → 上一首
 * POST /player/next          → 下一首
 * POST /player/mode          → 设置播放模式
 * GET  /player/status        → 获取播放状态
 */
export function registerPlaylistHandlers(
  router: Router,
  playlistManagerMap: PlaylistManagerMap,
  minaService: MinaService,
  configManager: ConfigManager,
): void {

  // GET /playlists - 获取歌单列表
  router.get('/playlists', async (req: HTTPRequest) => {
    try {
      const config = await configManager.getConfig();
      if (!config.server_host) {
        // 未配置服务器地址时返回空列表（附带提示信息），而不是 400 错误
        return jsonResponse({ success: true, data: [], message: '未配置服务器地址，请先在「设置」中配置服务器地址。' });
      }
      if (isLoopbackAddress(config.server_host)) {
        // 回环地址时返回空列表（附带提示信息），而不是 400 错误
        return jsonResponse({ success: true, data: [], message: '服务器地址为本地回环地址（localhost/127.0.0.1），MIoT 智能音箱无法访问。请在「设置」中修改为局域网 IP 地址。' });
      }
      const playlists = await mimusic.playlists.list();
      return jsonResponse({ success: true, data: playlists });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /playlists/:id/songs - 获取歌单歌曲
  router.get('/playlists/:id/songs', async (req: HTTPRequest, params: Record<string, string>) => {
    try {
      const playlistId = Number(params.id);
      if (!playlistId || isNaN(playlistId)) {
        return jsonResponse({ success: false, error: 'invalid playlist id' });
      }
      const songs = await mimusic.playlists.getSongs(playlistId, { limit: 100000 });
      return jsonResponse({ success: true, data: songs });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/play - 播放歌单
  router.post('/player/play', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id, playlist_id, start_index, play_mode } = body;

      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id) {
        return jsonResponse({ success: false, error: 'device_id is required' });
      }
      if (!playlist_id) {
        return jsonResponse({ success: false, error: 'playlist_id is required' });
      }

      // 检查服务器地址
      const config = await configManager.getConfig();
      if (!config.server_host) {
        return jsonResponse({ success: false, error: '未配置服务器地址，请先在「设置」中配置服务器地址。' });
      }
      if (isLoopbackAddress(config.server_host)) {
        return jsonResponse({ success: false, error: '服务器地址为本地回环地址，MIoT 智能音箱无法访问。请在「设置」中修改为局域网 IP 地址。' });
      }

      const manager = await playlistManagerMap.getOrCreate(account_id, device_id);
      const mode: PlayMode = play_mode || 'order';
      const ok = await manager.play(Number(playlist_id), start_index || 0, mode);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to start playlist' });
      }

      return jsonResponse({
        success: true,
        data: {
          message: 'playlist started',
          playlist_id: Number(playlist_id),
          play_mode: mode,
          current_song: manager.getCurrentSong(),
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/stop - 停止播放
  router.post('/player/stop', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }
      await manager.stop();
      return jsonResponse({ success: true, data: { message: 'playlist stopped' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/previous - 上一首
  router.post('/player/previous', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }

      const ok = await manager.previous();
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to play previous' });
      }
      return jsonResponse({ success: true, data: { message: 'playing previous song', current_song: manager.getCurrentSong() } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/next - 下一首
  router.post('/player/next', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }

      const ok = await manager.next();
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to play next' });
      }
      return jsonResponse({ success: true, data: { message: 'playing next song', current_song: manager.getCurrentSong() } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/mode - 设置播放模式
  router.post('/player/mode', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;
      const play_mode = body.play_mode;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      if (!play_mode) {
        return jsonResponse({ success: false, error: 'play_mode is required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }

      await manager.setPlayMode(play_mode as PlayMode);
      return jsonResponse({ success: true, data: { message: 'play mode set', play_mode } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /player/status - 获取播放状态
  router.get('/player/status', async (req: HTTPRequest) => {
    try {
      const query = parseQuery(req.query);
      const { account_id, device_id } = query;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = await playlistManagerMap.getOrCreate(account_id, device_id);
      const status = manager.getStatus();
      return jsonResponse({ success: true, data: status });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}
