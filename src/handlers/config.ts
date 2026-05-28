// MIoT 智能音箱插件 - 配置 Handler
// 翻译自 Go 源码: plugins/mimusic-plugin-xiaomi/handlers/config_handler.go

import { jsonResponse } from '@mimusic/plugin-sdk';
import type { Router, HTTPRequest } from '@mimusic/plugin-sdk';
import { ConfigManager } from '../config/manager';
import { ConversationMonitor } from '../conversation/monitor';
import { Scheduler } from '../schedule/scheduler';
import { VoiceEngine } from '../voicecmd/engine';
import { setHostBaseUrl } from '../utils/http';

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

/** 获取服务器地址状态 */
function getServerHostStatus(host: string): string {
  if (!host) return 'empty';
  if (isLoopbackAddress(host)) return 'loopback';
  return 'ok';
}

/**
 * 注册配置相关路由
 * GET  /config → 获取配置
 * POST /config → 更新配置
 */
export function registerConfigHandlers(
  router: Router,
  configManager: ConfigManager,
  conversationMonitor: ConversationMonitor,
  scheduler: Scheduler,
  voiceEngine: VoiceEngine,
): void {

  // GET /config - 获取配置
  router.get('/config', async (req: HTTPRequest) => {
    try {
      const config = await configManager.getConfig();
      return jsonResponse({
        success: true,
        data: {
          server_host: config.server_host,
          conversation_monitor_enabled: config.conversation_monitor_enabled,
          voice_command_enabled: config.voice_command_enabled,
          scheduled_tasks_enabled: config.scheduled_tasks_enabled,
          timezone: config.timezone,
          server_host_status: getServerHostStatus(config.server_host),
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) }, 500);
    }
  });

  // POST /config - 更新配置
  router.post('/config', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const config = await configManager.getConfig();

      // 更新 server_host
      if (body.server_host !== undefined) {
        config.server_host = body.server_host;
        // 同步更新宿主 API 基础 URL，确保 PlaylistManager/URLBuilder 能读取到最新值
        setHostBaseUrl(body.server_host || '');
      }

      // 更新 timezone
      if (body.timezone !== undefined) {
        config.timezone = body.timezone;
      }

      // 更新 conversation_monitor_enabled（联动 Monitor 启停）
      if (body.conversation_monitor_enabled !== undefined) {
        const enabled = !!body.conversation_monitor_enabled;
        config.conversation_monitor_enabled = enabled;
        if (enabled) {
          conversationMonitor.stop();   // 先确保清理旧状态
          conversationMonitor.start();  // 再干净启动
        } else {
          conversationMonitor.stop();
        }
      }

      // 更新 voice_command_enabled
      if (body.voice_command_enabled !== undefined) {
        const enabled = !!body.voice_command_enabled;
        config.voice_command_enabled = enabled;
        voiceEngine.setEnabled(enabled);
      }

      // 更新 scheduled_tasks_enabled（联动 Scheduler 启停）
      if (body.scheduled_tasks_enabled !== undefined) {
        const enabled = !!body.scheduled_tasks_enabled;
        config.scheduled_tasks_enabled = enabled;
        if (enabled) {
          scheduler.start();
        } else {
          scheduler.stop();
        }
      }

      await configManager.saveConfig(config);

      // 检查保存后的地址是否有效，附带 warning
      let warning = '';
      if (!config.server_host) {
        warning = '服务器地址为空，MIoT 智能音箱将无法播放音乐。请配置局域网 IP 地址（如 http://192.168.x.x:58091）。';
      } else if (isLoopbackAddress(config.server_host)) {
        warning = '检测到服务器地址为本地回环地址，MIoT 智能音箱将无法通过此地址访问服务器播放音乐。请使用局域网 IP 地址。';
      }

      const resp: any = { success: true };
      if (warning) {
        resp.warning = warning;
      }
      return jsonResponse(resp);
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) }, 500);
    }
  });
}
