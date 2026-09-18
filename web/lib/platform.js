// 运行平台能力检测（纯函数，便于单测）。
//
// 移动端浏览器普遍不支持"选择整个文件夹"（iOS Safari 没有 webkitdirectory，
// Android 上也常被文件管理器接管），因此手机上不展示「登记文件夹」入口。

const MOBILE_UA = /Android|iPhone|iPod|iPad|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Mobile/i;

/** 浏览器家族（只区分会用到差异行为的几家）。 */
export function browserFamily(userAgent = '') {
  const ua = String(userAgent);
  if (/Edg\/|EdgA\/|EdgiOS\//.test(ua)) {
    return 'edge';
  }
  if (/Firefox\/|FxiOS\//.test(ua)) {
    return 'firefox';
  }
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) {
    return 'chromium';
  }
  if (/Safari\//.test(ua)) {
    return 'safari';
  }
  return 'other';
}

/** 根据 UA / 触控点数判断是否手机（含 iPadOS 13+ 自称 Macintosh 的情况）。 */
export function isMobileUserAgent(userAgent = '', { maxTouchPoints = 0, platform = '' } = {}) {
  const ua = String(userAgent);
  if (MOBILE_UA.test(ua)) {
    return true;
  }
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) {
    return true; // iPadOS 13+ 桌面版 UA
  }
  return /Android|iPhone|iPad/i.test(String(platform));
}

/**
 * 一次性探测：是否手机、能不能选文件夹、要不要隐藏「登记文件夹」按钮。
 * @param {object} [scope] 便于测试注入（默认全局 window）
 */
export function detectPlatform(scope = globalThis) {
  const navigatorLike = scope?.navigator ?? {};
  let folderInputSupported = false;
  try {
    const input = scope?.document?.createElement?.('input');
    if (input) {
      input.type = 'file';
      input.setAttribute('webkitdirectory', '');
      folderInputSupported = input.webkitdirectory === true;
    }
  } catch {
    folderInputSupported = false;
  }

  const folderPickerApi = typeof scope?.showDirectoryPicker === 'function';
  const isMobile = isMobileUserAgent(navigatorLike.userAgent ?? '', {
    maxTouchPoints: navigatorLike.maxTouchPoints ?? 0,
    platform: navigatorLike.platform ?? '',
  });
  const family = browserFamily(navigatorLike.userAgent ?? '');
  const ua = String(navigatorLike.userAgent ?? '');
  const isLinux = /Linux|X11/i.test(ua) && !/Android/i.test(ua);
  const hasDirectoryCapability = folderPickerApi || folderInputSupported;
  // Linux 桌面上旧的 webkitdirectory 会退化成"选择文件"对话框、拖放也可能受桌面环境限制，
  // 所以只有在能拿到浏览器推荐的目录 API（File System Access）时才显示「登记文件夹」。
  const folderButtonHiddenReason = isMobile
    ? 'mobile'
    : isLinux && !folderPickerApi
      ? 'linux-no-directory-api'
      : hasDirectoryCapability
        ? null
        : 'no-directory-support';
  return {
    isMobile,
    browser: family,
    isFirefox: family === 'firefox',
    isLinux,
    folderPickerApi,
    folderInputSupported,
    canPickFolder: hasDirectoryCapability,
    folderButtonHiddenReason,
    shouldHideFolderButton: folderButtonHiddenReason !== null,
  };
}
