/* commons_autofill.js
 * Rock Legends: Wikimedia Commons 이미지/저작권(라이선스) 메타 자동 로드
 * - GitHub Pages 같은 정적 호스팅에서도 fetch로 동작
 * - Wikidata(P18) -> Wikimedia Commons(imageinfo + extmetadata) 순으로 조회
 *
 * 참고: MediaWiki Action API는 CORS를 지원하며(origin=*), CommonsMetadata(extmetadata)로 라이선스/저자 정보를 받을 수 있습니다.
 */
(() => {
  'use strict';

  const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
  const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

  const CACHE_KEY = 'rocklegends_commons_cache_v1';
  const FAVORITES_KEY = 'rocklegends_favorites_v1';

 function safeJsonParse(str, fallback) {
  // localStorage.getItem()이 null을 줄 수 있음
  if (str == null || str === '') return fallback;
  try {
    const v = JSON.parse(str);
    return (v == null) ? fallback : v; // "null"도 fallback 처리
  } catch {
    return fallback;
  }
}

function loadCache() {
  const c = safeJsonParse(localStorage.getItem(CACHE_KEY), {});
  return (c && typeof c === 'object') ? c : {};
}
  function saveCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function stripHtml(s) {
    return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function pickBestWikidataSearchResult(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    // description에 band/rock/group 등이 있으면 우선
    const re = /(band|rock|group|musician|musical)/i;
    return items.find(x => re.test(x.description || '')) || items[0];
  }

  async function wikidataFindP18FileName(name) {
    const q = encodeURIComponent(name);
    const sUrl = `${WIKIDATA_API}?action=wbsearchentities&search=${q}&language=en&limit=6&format=json&origin=*`;
    const s = await fetchJson(sUrl);
    const best = pickBestWikidataSearchResult(s.search);
    if (!best?.id) return null;

    const eUrl = `${WIKIDATA_API}?action=wbgetentities&ids=${best.id}&props=claims&format=json&origin=*`;
    const e = await fetchJson(eUrl);
    const claims = e?.entities?.[best.id]?.claims;
    const p18 = claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    return typeof p18 === 'string' && p18.length ? p18 : null;
  }

  async function commonsSearchFileName(name) {
    // Wikidata에 P18이 없을 때 fallback: Commons 파일 네임스페이스(File:) 검색
    const q = encodeURIComponent(`${name} band`);
    const url = `${COMMONS_API}?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=10&prop=info&inprop=url&format=json&origin=*`;
    const data = await fetchJson(url);
    const pages = data?.query?.pages;
    if (!pages) return null;

    const arr = Object.values(pages).sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

    // 로고/앨범커버 등은 제외(가능하면 인물/공연 사진 우선)
    const bad = (title) => {
      const t = (title || '').toLowerCase();
      return t.endsWith('.svg') || t.includes('logo') || t.includes('album') || t.includes('cover');
    };

    const pick = arr.find(p => !bad(p.title)) || arr[0];
    const title = pick?.title || '';
    const m = title.match(/^File:(.+)$/);
    return m ? m[1] : null;
  }

  async function commonsImageInfo(fileName) {
    const title = encodeURIComponent(`File:${fileName}`);
    // extmetadata는 CommonsMetadata(Extension:CommonsMetadata)가 제공
    const url = `${COMMONS_API}?action=query&titles=${title}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1000&format=json&origin=*`;
    const data = await fetchJson(url);

    const pagesObj = data?.query?.pages;
    const page = Array.isArray(pagesObj) ? pagesObj[0] : pagesObj ? Object.values(pagesObj)[0] : null;
    const ii = page?.imageinfo?.[0];
    if (!ii) return null;

    const meta = ii.extmetadata || {};
    const licenseName = meta.LicenseShortName?.value || meta.License?.value || '';
    const licenseUrl = meta.LicenseUrl?.value || '';
    const artistRaw = meta.Artist?.value || meta.Credit?.value || meta.Attribution?.value || '';
    const credit = stripHtml(artistRaw) || '작성자 정보 없음';

    const filePageUrl =
      ii.descriptionurl ||
      `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(String(fileName).replace(/ /g, '_'))}`;

    const imageUrl = ii.thumburl || ii.url || '';

    return { fileName, imageUrl, filePageUrl, credit, licenseName, licenseUrl };
  }

  async function ensureBandImageAndMeta(name, year) {
    if (!name) return null;

    const cache = loadCache();
    if (cache[name]?.imageUrl || cache[name]?.missing) return cache[name];

    let fileName = null;

    try { fileName = await wikidataFindP18FileName(name); } catch {}
    if (!fileName) {
      try { fileName = await commonsSearchFileName(name); } catch {}
    }

    if (!fileName) {
      const missing = { name, year, missing: true, fetchedAt: Date.now() };
      cache[name] = missing;
      saveCache(cache);
      return missing;
    }

    const info = await commonsImageInfo(fileName);
    if (!info?.imageUrl) {
      const missing = { name, year, missing: true, fileName, fetchedAt: Date.now() };
      cache[name] = missing;
      saveCache(cache);
      return missing;
    }

    const entry = { name, year, ...info, fetchedAt: Date.now() };
    cache[name] = entry;
    saveCache(cache);
    return entry;
  }

  function patchFavoriteImgIfNeeded(name, year, imageUrl) {
    try {
      const list = safeJsonParse(localStorage.getItem(FAVORITES_KEY), []);
      let changed = false;

      for (const it of list) {
        if (it && it.name === name && it.img !== imageUrl) {
          it.img = imageUrl;
          if (year && !it.year) it.year = year;
          changed = true;
        }
      }
      if (changed) localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
    } catch {}
  }

  function buildCreditLi(meta) {
    const li = document.createElement('li');

    if (!meta || meta.missing) {
      li.innerHTML = `
        <strong>${escapeHtml(meta?.name || 'Unknown')} (${escapeHtml(String(meta?.year || ''))}s)</strong><br>
        Wikimedia Commons에서 적절한 이미지를 찾지 못했습니다.
      `.trim();
      return li;
    }

    const creditText = `사진: ${escapeHtml(meta.credit || '작성자 정보 없음')}`;
    const commonsLink = `<a href="${escapeHtml(meta.filePageUrl)}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
    const license =
      meta.licenseUrl
        ? `<a href="${escapeHtml(meta.licenseUrl)}" target="_blank" rel="noopener">${escapeHtml(meta.licenseName || '라이선스')}</a>`
        : `${escapeHtml(meta.licenseName || '라이선스 정보 없음')}`;

    li.innerHTML = `
      <strong>${escapeHtml(meta.name)} (${escapeHtml(String(meta.year || ''))}s)</strong><br>
      ${creditText} · ${commonsLink}<br>
      라이선스: ${license}
    `.trim();

    return li;
  }

  async function mapLimit(items, limit, worker, onProgress) {
    const arr = Array.from(items || []);
    let i = 0;
    let done = 0;
    const results = new Array(arr.length);

    const runners = new Array(Math.max(1, limit)).fill(null).map(async () => {
      while (i < arr.length) {
        const idx = i++;
        try {
          results[idx] = await worker(arr[idx], idx);
        } finally {
          done++;
          if (typeof onProgress === 'function') onProgress(done, arr.length);
        }
      }
    });

    await Promise.all(runners);
    return results;
  }

  function clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch {}
  }

  window.RockLegendsCommons = {
    ensureBandImageAndMeta,
    patchFavoriteImgIfNeeded,
    buildCreditLi,
    mapLimit,
    loadCache,
    clearCache,
    CACHE_KEY
  };
})();
