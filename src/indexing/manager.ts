// MIoT 智能音箱插件 - 索引管理模块
// 从 MiMusic 主程序API获取歌曲/歌单数据，建立内存索引，提供模糊搜索

// ===== 类型定义 =====

/** 索引中的歌曲信息 */
export interface IndexedSong {
  id: number;
  title: string;
  artist: string;
  album: string;
  titleLower: string;   // 小写化用于搜索
  artistLower: string;  // 小写化用于搜索
}

/** 歌曲在歌单中的位置信息（用于语音口令播放歌曲） */
export interface SongLocation {
  playlistId: number;
  playlistName: string;
  songIndex: number;
  songTitle: string;
  artist: string;
}

/** 索引中的歌单信息 */
export interface IndexedPlaylist {
  id: number;
  name: string;
  nameLower: string;    // 小写化用于搜索
  songCount: number;
}

/** 索引状态（字段名使用蛇形式，与 WASM 版保持一致） */
export interface IndexStatus {
  ready: boolean;
  song_count: number;
  playlist_count: number;
  last_refresh_time: string;
  is_refreshing: boolean;
}

/** 模糊搜索评分结果（内部使用） */
interface ScoredResult<T> {
  item: T;
  score: number;
}

// ===== 模糊搜索算法 =====

/**
 * 编辑距离（Levenshtein Distance），支持 Unicode
 * 使用两行滚动数组优化空间
 */
function levenshteinDistance(a: string, b: string): number {
  const ra = Array.from(a);
  const rb = Array.from(b);
  const la = ra.length;
  const lb = rb.length;

  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);

  for (let j = 0; j <= lb; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = ra[i - 1] === rb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,   // 删除
        prev[j] + 1,       // 插入
        prev[j - 1] + cost, // 替换
      );
    }
    // 交换行
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[lb];
}

/**
 * 计算两个字符串的相似度 (0.0 ~ 1.0)
 * similarity = 1 - distance / max(len(a), len(b))
 */
function similarity(a: string, b: string): number {
  const al = Array.from(a.toLowerCase());
  const bl = Array.from(b.toLowerCase());
  const maxLen = Math.max(al.length, bl.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1.0 - dist / maxLen;
}

/**
 * 三级模糊搜索评分（参考Go实现的 fuzzySearch）
 *
 * 1. 精确匹配（忽略大小写）：得分 100
 * 2. 包含匹配（忽略大小写）：
 *    - 候选项包含关键词：50 + 1/rune长度
 *    - 关键词包含候选项：40 + 1/rune长度
 * 3. 编辑距离模糊匹配：similarity > 0.5 时得分 similarity * 30
 *
 * @returns 得分，0 表示不匹配
 */
function fuzzyScore(keyword: string, candidate: string): number {
  const keywordLower = keyword.toLowerCase();
  const candidateLower = candidate.toLowerCase();

  // 第一级：精确匹配
  if (candidateLower === keywordLower) {
    return 100.0;
  }

  // 第二级：包含匹配
  if (candidateLower.includes(keywordLower)) {
    const runeLen = Array.from(candidate).length;
    return runeLen > 0 ? 50.0 + 1.0 / runeLen : 50.0;
  }

  // 第二级变体：关键词包含候选项
  if (keywordLower.includes(candidateLower)) {
    const runeLen = Array.from(candidate).length;
    return runeLen > 0 ? 40.0 + 1.0 / runeLen : 40.0;
  }

  // 第三级：编辑距离模糊匹配
  const sim = similarity(keyword, candidate);
  if (sim > 0.5) {
    return sim * 30.0;
  }

  return 0;
}

/**
 * 对候选列表进行模糊搜索，支持分词（空格分隔的所有词都需匹配）
 * 返回按得分降序排列的匹配结果
 */
function fuzzySearchList<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  limit: number,
): T[] {
  if (!query || items.length === 0) return [];

  const queryTrimmed = query.trim();
  if (!queryTrimmed) return [];

  // 分词：按空格分词
  const terms = queryTrimmed.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  const scored: ScoredResult<T>[] = [];

  for (const item of items) {
    const text = getText(item);

    if (terms.length === 1) {
      // 单词直接评分
      const score = fuzzyScore(terms[0], text);
      if (score > 0) {
        scored.push({ item, score });
      }
    } else {
      // 多词搜索：所有词都需要在目标中出现（子串包含），取最低分
      const textLower = text.toLowerCase();
      let allMatch = true;
      let minScore = Infinity;

      for (const term of terms) {
        if (!textLower.includes(term.toLowerCase())) {
          allMatch = false;
          break;
        }
        const s = fuzzyScore(term, text);
        if (s < minScore) minScore = s;
      }

      if (allMatch && minScore > 0) {
        scored.push({ item, score: minScore });
      }
    }
  }

  // 按得分降序排列
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(s => s.item);
}

// ===== 索引管理器 =====

/** 搜索结果最大返回数 */
const MAX_SEARCH_RESULTS = 10;

/**
 * 索引管理器
 * 从 MiMusic 宿主API获取歌曲/歌单数据，建立内存索引，提供模糊搜索
 */
export class IndexingManager {
  private songs: IndexedSong[] = [];
  private playlists: IndexedPlaylist[] = [];
  private lastRefreshTime: number = 0;
  private isRefreshing: boolean = false;
  private indexReady: boolean = false;

  /**
   * 刷新索引（从宿主API获取最新数据）
   * @returns 刷新结果
   */
  async refresh(): Promise<{ success: boolean; songCount: number; playlistCount: number }> {
    if (this.isRefreshing) {
      return { success: false, songCount: this.songs.length, playlistCount: this.playlists.length };
    }

    this.isRefreshing = true;
    try {
      // 1. 获取歌单列表（桥接直接返回数组）
      const rawPlaylists = (await mimusic.playlists.list()) ?? [];

      // 2. 获取歌曲列表（桥接直接返回数组）
      const rawSongs = (await mimusic.songs.list({ limit: 10000 })) ?? [];

      // 3. 构建歌单索引
      const newPlaylists: IndexedPlaylist[] = rawPlaylists.map(pl => ({
        id: pl.id,
        name: pl.name,
        nameLower: pl.name.toLowerCase(),
        songCount: (pl as any).song_count ?? (pl as any).songCount ?? 0,
      }));

      // 4. 构建歌曲索引
      const newSongs: IndexedSong[] = rawSongs.map(song => ({
        id: song.id,
        title: song.title ?? '',
        artist: song.artist ?? '',
        album: song.album ?? '',
        titleLower: (song.title ?? '').toLowerCase(),
        artistLower: (song.artist ?? '').toLowerCase(),
      }));

      // 5. 更新索引
      this.playlists = newPlaylists;
      this.songs = newSongs;
      this.lastRefreshTime = Date.now();
      this.indexReady = true;

      mimusic.log.info(`索引构建完成: playlists=${newPlaylists.length} songs=${newSongs.length}`);
      return { success: true, songCount: newSongs.length, playlistCount: newPlaylists.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mimusic.log.warn(`索引刷新失败: ${msg}`);
      this.indexReady = false;
      return { success: false, songCount: this.songs.length, playlistCount: this.playlists.length };
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * 获取索引状态
   */
  getStatus(): IndexStatus {
    return {
      ready: this.indexReady,
      song_count: this.songs.length,
      playlist_count: this.playlists.length,
      last_refresh_time: this.lastRefreshTime > 0
        ? new Date(this.lastRefreshTime).toISOString()
        : '',
      is_refreshing: this.isRefreshing,
    };
  }

  /**
   * 模糊搜索歌单（用于语音口令匹配）
   * 按匹配度排序：精确匹配 > 开头匹配 > 包含匹配
   * @param query - 搜索关键词
   * @returns 最多10个匹配结果
   */
  searchPlaylist(query: string): IndexedPlaylist[] {
    return fuzzySearchList(
      query,
      this.playlists,
      pl => pl.name,
      MAX_SEARCH_RESULTS,
    );
  }

  /**
   * 模糊搜索歌曲（匹配标题或歌手）
   * @param query - 搜索关键词
   * @returns 最多10个匹配结果
   */
  searchSong(query: string): IndexedSong[] {
    if (!query || !query.trim()) return [];

    const queryTrimmed = query.trim();
    const scored: ScoredResult<IndexedSong>[] = [];

    for (const song of this.songs) {
      // 分别对 title 和 artist 评分，取较高分
      const titleScore = fuzzyScore(queryTrimmed, song.title);
      const artistScore = fuzzyScore(queryTrimmed, song.artist);
      const score = Math.max(titleScore, artistScore);

      if (score > 0) {
        scored.push({ item: song, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_SEARCH_RESULTS).map(s => s.item);
  }

  /**
   * 精确匹配歌单名（忽略大小写）
   * 如果精确匹配失败，回退到模糊搜索返回第一个结果
   * @param name - 歌单名称
   * @returns 匹配到的歌单，未找到返回 null
   */
  findPlaylistByName(name: string): IndexedPlaylist | null {
    if (!name) return null;

    const nameLower = name.toLowerCase();

    // 精确匹配
    const exact = this.playlists.find(pl => pl.nameLower === nameLower);
    if (exact) return exact;

    // 回退到模糊搜索
    const results = this.searchPlaylist(name);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * 按ID获取歌单
   * @param id - 歌单ID
   * @returns 歌单信息，未找到返回 null
   */
  getPlaylistById(id: number): IndexedPlaylist | null {
    return this.playlists.find(pl => pl.id === id) ?? null;
  }

  /**
   * 在指定歌单中按歌曲名称查找索引位置
   * 先精确匹配（忽略大小写），再回退模糊搜索
   * @param playlistId - 歌单ID
   * @param songName - 歌曲名称
   * @returns { index, found }，index 为歌曲在歌单中的位置
   */
  async findSongInPlaylist(playlistId: number, songName: string): Promise<{ index: number; found: boolean }> {
    if (!this.indexReady || !songName) {
      return { index: 0, found: false };
    }

    // 获取歌单歌曲列表
    let songs: Array<{ id: number; title?: string; artist?: string }> = [];
    try {
      const result = await mimusic.playlists.getSongs(playlistId);
      if (result && Array.isArray(result)) {
        songs = result;
      }
    } catch (e) {
      mimusic.log.warn(`[IndexingManager] 获取歌单歌曲失败: ${e instanceof Error ? e.message : String(e)}`);
      return { index: 0, found: false };
    }

    if (songs.length === 0) {
      return { index: 0, found: false };
    }

    // 收集候选列表用于模糊匹配
    const candidates = songs.map((s, i) => ({ title: s.title ?? '', index: i }));

    // 使用 fuzzySearchList 搜索最佳匹配
    const matched = fuzzySearchList(
      songName,
      candidates,
      c => c.title,
      1,
    );

    if (matched.length > 0) {
      return { index: matched[0].index, found: true };
    }

    return { index: 0, found: false };
  }

  /**
   * 按歌曲名称模糊匹配，返回歌曲位置信息（歌单ID + 索引）
   * 参考 Go 版本: indexing/manager.go FindSongByName
   * @param songName - 歌曲名称关键词
   * @returns 匹配到的歌曲位置，未找到返回 null
   */
  async findSongByName(songName: string): Promise<SongLocation | null> {
    if (!this.indexReady || !songName) return null;

    // 1. 用内存歌曲索引模糊搜索匹配歌曲
    const matchedSongs = this.searchSong(songName);
    if (matchedSongs.length === 0) return null;

    // 收集匹配歌曲的 ID 集合，用于快速查找
    const matchedSongIds = new Set(matchedSongs.map(s => s.id));

    // 2. 遍历歌单，按需加载歌曲列表查找位置
    for (const pl of this.playlists) {
      try {
        const plSongs = (await mimusic.playlists.getSongs(pl.id, { limit: 100000 })) ?? [];
        for (let idx = 0; idx < plSongs.length; idx++) {
          if (matchedSongIds.has(plSongs[idx].id)) {
            return {
              playlistId: pl.id,
              playlistName: pl.name,
              songIndex: idx,
              songTitle: plSongs[idx].title ?? '',
              artist: plSongs[idx].artist ?? '',
            };
          }
        }
      } catch (e) {
        mimusic.log.warn(`findSongByName: 获取歌单歌曲失败 playlist_id=${pl.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return null;
  }

  /**
   * 索引是否就绪
   */
  isIndexReady(): boolean {
    return this.indexReady;
  }
}
